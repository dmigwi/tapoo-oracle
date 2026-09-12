// Tapoo agent-api log contract.
//
// This module is the definition of what a downloaded Tapoo log looks like for everything under src/ -
// the app, its rubric engine, and the maze replay all read a log through here and nowhere else.
//
// Not for scripts/agentic-analysis.mjs. That CLI imports nothing but node: builtins and carries its own
// reader and its own evaluator, which its header calls a known migration gap. So the two front ends can
// answer the same log differently, and folding it onto this module is what would stop that.
//
// It deliberately imports no dependencies and no node: builtins, so it runs unchanged in Node and in a
// browser bundle.
//
// The producer of this shape is frontend/app/logs.ts (tapooDownloadLogs) writing entries typed as
// LogEntry in frontend/app/types.ts. When that producer changes, this file changes with it, and
// LOG_CONTRACT_VERSION below is what tells a consumer it is looking at something it does not know
// how to read.

import type {
  CellKey,
  OpenCellExits,
  TurnReports,
  EncodedMaze,
  ParsedRound,
  AgentSummary,
  LogWarning,
  MazeResult,
  TurnSummary,
  ValidationCheck,
  AssistantMessage,
  ResponseUsage,
  LogEntry,
  LogTextResult,
  TapooLog,
} from "./types";

import {asArray, asRecord, asTrimmedText, fnv1a64Checksum, formatCount, isRecord} from "./utils";
import {cellFromGridPoint, mazeFromEncoded} from "./maze";
// Imported as well as re-exported below: a re-export puts a name on this module's surface without
// putting it in scope, and traversalPayloadWarnings needs to call them.
import {cellFromKey, cellFromLogged, cellKeyFromLogged, statusesFromLogged, stepFrom} from "./geometry";

export {
  AGENT_API_MODE,
  DECLARED_TOOLS,
  EVENT_CLASSES,
  KNOWN_EVENTS,
  LOG_CONTRACT_VERSION,
  LOG_ENVELOPE_NAME,
  LOG_EVENTS,
  LOG_LEVELS,
  levelClassOf,
} from "./log-events";
import {AGENT_API_MODE, LOG_ENVELOPE_NAME, LOG_EVENTS, LOG_LEVELS} from "./log-events";

// Re-exported: every caller of these is reading the log contract, and that is still where they look.
export {
  MOVES,
  cellFromKey,
  cellFromLogged,
  cellKeyFromLogged,
  classifyTraversalSpeed,
  getCellKey,
  isMove,
  openMovesFromLogged,
  statusesFromLogged,
  stepFrom,
} from "./geometry";

/** turnReports stores per-turn payloads under the turn they describe.
 *
 * Tapoo reports a turn's outcome on the request that *follows* it, so a payload logged on turn N -
 * get_maze_structure, get_prediction_rules, get_last_prediction_outcome - covers turn N - 1.
 *
 * That offset lives on one line, inside this store, and nowhere else. Held as arithmetic at each call
 * site instead, every writer has to remember it and every reader has to trust that they did - and the
 * three spellings it invites, `turn + 1`, `reportedAt - 1`, and no adjustment at all, are all valid
 * TypeScript. A reader that shifts the wrong way draws the maze overlay a turn behind the maze.
 *
 * `record` is the only way in and takes the turn that *carried* a payload; `get` is the only way out and
 * takes the turn it *covers*. A caller holding the offset separately is the bug this closes, so there is
 * no exported helper to hold.
 *
 * Turn 0's payload covers turn -1: there is no turn before the first, so that key holds the state the
 * round opened in and matches no turn.
 *
 * A turn writes more than once whenever it makes more than one request. What should happen then is the
 * caller's to say, through `merge`: visit statuses accumulate, and an outcome keeps the first reading,
 * because a turn that runs again after a failure re-reads the tool and gets an answer about itself. */
export function turnReports<T>(): TurnReports<T> {
  const byTurn = new Map<number, T>();

  // The ascending order, built after the last write and kept until the next one.
  //
  // Sorted rather than trusted to insertion order: entries do arrive in recorded order today, but a
  // reader that walks them to a bound is relying on the ordering, not on the writer's habits. Held
  // rather than recomputed because reading is the hot path and writing is not - the scrubber asks for
  // this order on every frame it draws, long after the round stopped being written to.
  let ordered: Array<[number, T]> | null = null;

  return {
    record(reportingTurn, value, merge) {
      const turn = reportingTurn - 1;
      const existing = byTurn.get(turn);
      byTurn.set(turn, existing !== undefined && merge ? merge(existing, value) : value);
      ordered = null;
    },
    get: (turn) => byTurn.get(turn),
    ascending: () => (ordered ??= [...byTurn].sort(([a], [b]) => a - b)),
    values: () => [...byTurn.values()],
    get size() {
      return byTurn.size;
    },
  };
}

// --- Reading a provider response ---

/** assistantMessage reads one model response, whichever of the three providers produced it.
 *
 * Tapoo logs the provider's response body verbatim, so the shape belongs to the provider. Its own
 * adapters (frontend/app/agent/providers.ts) define all three, and they agree on nothing structural:
 *
 *   Ollama     {message: {content, thinking, tool_calls}}                 - verified against real logs
 *   OpenAI     {choices: [{message: {content, reasoning_content, tool_calls}}]}  - verified
 *   Anthropic  {content: [{type: "text"|"thinking"|"tool_use", ...}]}     - from the adapter only
 *
 * The Anthropic branch is written from Tapoo's adapter and covered by tests built from it, but no
 * Anthropic log has ever been run through it. It is kept rather than dropped because the alternative
 * is worse than an unverified reader: without it an Anthropic log returns null here, and null now
 * raises a warning that says the responses could not be read (see unreadableResponseWarnings) instead
 * of failing silently the way the OpenAI shape did.
 *
 * Reading only Ollama's shape is what made a whole log analyze to nothing: every OpenAI response has
 * no `message` at the root, so each counted as empty - zero predictions, zero turns, and a replay
 * scrubber reading "0 / 0" under a maze that drew correctly. Anthropic would have failed the same way
 * for the same reason, so all three are read here rather than two.
 *
 * Providers are told apart by shape, not by the `api` field or the endpoint URL. Both are recorded in
 * the log and either would work, but a body that looks like a response is better evidence about that
 * body than a label written beside it. */
export function assistantMessage(payload: unknown): AssistantMessage | null {
  const body = asRecord(payload);

  // Ollama, then OpenAI: both wrap a single message object.
  const wrapped = isRecord(body.message)
      ? body.message
      : (() => {
          const [choice] = asArray(body.choices);
          // Only the first choice. Tapoo asks for one completion, and scoring a second would credit
          // the agent with a prediction it was never judged on.
          const message = asRecord(choice).message;
          return isRecord(message) ? message : null;
        })();

  if (wrapped) {
    return {
      content: typeof wrapped.content === "string" ? wrapped.content : null,
      toolNames: toolNamesOf(wrapped.tool_calls),
      // `thinking` is Ollama's name and `reasoning_content` is OpenAI's for the same thing.
      reasoning:
        typeof wrapped.thinking === "string"
          ? wrapped.thinking
          : typeof wrapped.reasoning_content === "string"
            ? wrapped.reasoning_content
            : null,
    };
  }

  // Anthropic: typed content blocks, no wrapper. Text and thinking can each arrive in several blocks,
  // so both are concatenated rather than taken from the first.
  if (!Array.isArray(body.content)) {
    return null;
  }

  let content = "";
  let reasoning = "";
  const toolNames: string[] = [];

  for (const block of body.content as unknown[]) {
    const record = asRecord(block);
    if (record.type === "text" && typeof record.text === "string") content += record.text;
    else if (record.type === "thinking" && typeof record.thinking === "string") reasoning += record.thinking;
    else if (record.type === "tool_use" && typeof record.name === "string") toolNames.push(record.name);
  }

  return {
    content: content === "" ? null : content,
    toolNames,
    reasoning: reasoning === "" ? null : reasoning,
  };
}

// Ollama and OpenAI both use OpenAI's tool-call shape: a list of {function: {name}}.
function toolNamesOf(calls: unknown): string[] {
  if (!Array.isArray(calls)) return [];
  return (calls as unknown[])
    .map((call) => asRecord(asRecord(call).function).name)
    .filter((name): name is string => typeof name === "string" && name !== "");
}

/** responseUsage reads what the provider reported about its own work, in any of the three shapes.
 *
 * They report overlapping but different things, so every field is nullable and a null means "this
 * provider did not say" rather than zero. Ollama counts tokens at the payload root; OpenAI and Anthropic
 * nest them under `usage`. Only OpenAI says how many completion tokens were spent thinking, and both it
 * and Anthropic say how much of the prompt was served from cache rather than re-read. */
export function responseUsage(payload: unknown): ResponseUsage {
  const body = asRecord(payload);
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

  const usage = asRecord(body.usage);
  const [choice] = asArray(body.choices);

  const firstString = (...values: unknown[]): string | null => {
    for (const value of values) if (typeof value === "string" && value !== "") return value;
    return null;
  };

  return {
    // Ollama counts at the payload root; OpenAI and Anthropic nest under `usage` with different names.
    promptTokens: num(body.prompt_eval_count) ?? num(usage.prompt_tokens) ?? num(usage.input_tokens),
    // Anthropic's output_tokens already includes its extended-thinking tokens, which is why they are
    // not added on top - doing so would double-count the thinking against the completion budget.
    completionTokens: num(body.eval_count) ?? num(usage.completion_tokens) ?? num(usage.output_tokens),
    reasoningTokens: num(asRecord(usage.completion_tokens_details).reasoning_tokens),
    cachedPromptTokens: num(asRecord(usage.prompt_tokens_details).cached_tokens) ?? num(usage.cache_read_input_tokens),
    // Ollama's done_reason, OpenAI's per-choice finish_reason, Anthropic's stop_reason.
    finishReason: firstString(body.done_reason, asRecord(choice).finish_reason, body.stop_reason),
  };
}

// --- Validating an export ---

// isLogEntry reports whether one array element carries the three fields every consumer relies on: a
// payload, a timestamp, and a level it knows.
//
// turn, level and game are deliberately not among them, and this is the one thing here worth arguing
// about, because the current producer always writes them. logTapooRecordEntry in frontend/app/logs.ts
// stamps level, turn and game on every entry it writes, from the counters it holds - `details` is the
// sole field it writes conditionally - and the v2.5.0 vendored sample and the v2.5.1 snapshot both carry
// all three on every entry.
//
// A gate is not written for the producer of the day, though. rounds.test.ts records a real log of
// hundreds of turns that stamped game and level on its round boundaries only, and a gate insisting on
// them would have dropped every entry between those boundaries - which is the whole of the round. Older
// logs are exactly what an analyzer of logs is for.
//
// So the counters are read where present and worked around where not, and each fallback carries its own
// argument at its own site: a cursor in buildContext, an in-progress round in groupEntriesByRound,
// "Whole log" in roundLabel. Tightening this gate means dropping those logs, not tidying dead code.
//
// This holds for every Tapoo shape from v2.5.1 on, deliberately and until further notice. Neither
// project is settled enough to declare a version floor, so the analyzer reads what it is given rather
// than what the current build happens to write.
function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.payload === "string" &&
    typeof entry.epochMs === "number" &&
    typeof entry.log === "string" &&
    LOG_LEVELS.has(entry.log)
  );
}


/** How many of a list's model responses this contract could read, and how many it could not. */
type ResponseTally = {responses: number; unreadable: number};

/** Counts a list's model responses, and how many of their bodies this contract could not read.
 *
 * Counted once and read twice, which is why it is a tally passed to both readers rather than a call each
 * makes for itself: the file warns when any response in it is unreadable, and the same numbers are
 * reported as a check. Two calls walked every response in the log twice to reach the same pair. */
function countResponses(entries: LogEntry[]): ResponseTally {
  const responses = entries.filter((entry) => entry.payload === LOG_EVENTS.response);
  const unreadable = responses.filter((entry) => {
    const details = entry.details;
    const payload = details !== null && typeof details === "object" && "payload" in details
      ? details.payload
      : null;
    return assistantMessage(payload) === null;
  }).length;
  return {responses: responses.length, unreadable};
}

/** What the file's model responses report about themselves.
 *
 * Scoped to the file rather than the round: the question is whether this contract recognises the shape
 * the provider writes, and one file is one provider. Per-round counts would differ only in how many
 * responses each round happened to hold, which is not what the check is asking. */
function responseCheck({responses, unreadable}: ResponseTally): ValidationCheck {
  return {
    name: "Model responses",
    scope: "log",
    outcome: responses === 0 ? "unchecked" : unreadable > 0 ? "failed" : "passed",
    detail:
      responses === 0
        ? "the log carried no model responses"
        : unreadable > 0
          ? `${formatCount(unreadable)} of ${formatCount(responses)} model responses were in a provider shape this analyzer does not recognise`
          : `${formatCount(responses - unreadable)} of ${formatCount(responses)} model responses were read`,
  };
}

// unreadableResponseWarnings reports responses whose body this contract could not read at all.
//
// The check that was missing when it was needed most: a 1,459-entry log analyzed to zero predictions and
// zero turns because every response was in a provider shape this file did not know, and each was counted
// as an "empty response" - a thing that legitimately happens, so 719 quiet failures read as 719 models
// stopping early. One unreadable body is enough to say so: across 1,744 real responses not one has an
// unreadable *shape*, and the 49 blank ones all parse to a message holding no text.
//
// Inaccurate rather than incomplete, because the rubric answers NO on absent evidence: a prediction that
// was made but could not be read turns a YES into a NO. The verdicts are wrong, not merely fewer.
function unreadableResponseWarnings({responses, unreadable}: ResponseTally): LogWarning[] {
  if (unreadable === 0) {
    return [];
  }

  const all = unreadable === responses;
  return [{
    impact: "inaccurate",
    message:
      `${unreadable} of ${responses} model ${responses === 1 ? "response" : "responses"} ` +
      `could not be read: the body is not in a shape this analyzer recognises. ` +
      `${all ? "No prediction in this log was scored" : "Those turns were not scored"}, so a capability ` +
      "answered NO may only mean the evidence for it was unreadable.",
  }];
}

/** A logged message's text and the checksum beside it, each proved once.
 *
 * Both readers below take the same two fields off the same records. Narrowed at each of them instead,
 * "a readable message" has two definitions free to drift apart, and two values cost four checks.
 *
 * What they do not share is what a *missing* checksum means. promptWarnings has nothing to compare and
 * passes over it; traversalPayloadWarnings counts it as a payload it could not verify, which is a number
 * that reaches the report. So the checksum comes back nullable and that decision stays with the caller -
 * a shared reader should settle what the fields are, never what their absence implies.
 *
 * Null is "no text to read at all", which both treat the same way. */
function messageText(message: Record<string, unknown>): {content: string; checksum: string | null} | null {
  const {content, content_checksum: checksum} = message;
  if (typeof content !== "string") return null;
  return {content, checksum: typeof checksum === "string" ? checksum : null};
}

// --- The get_maze_structure payloads a round carried ---

/** What a round states about its maze, which is everything rebuilding one of its payloads needs.
 *
 * Gathered as a value so the reconstruction below can be read on its own. These four arrive on the
 * round's "Agent level started." entry and hold until the next one, and the walker keeps them as cursors
 * because a group keyed game/level can hold a replay of that level too. */
type RoundMaze = {
  exits: OpenCellExits;
  startCell: CellKey | null;
  destinationCell: unknown;
  historyWindowRadius: number;
};

/** filteredTraversalHistoryRebuild rebuilds the original `get_maze_structure` payload Tapoo hashed.
 *
 * The entry carries a compacted copy of the payload and a checksum taken over the original, so hashing
 * the text the entry holds can never reproduce it - it has to be checked against this. Every byte
 * matters: the key order, the compact separators, and cellType's precedence are all reproduced as Tapoo
 * writes them, and 16 of 16 checksummed results in the snapshot log come back identical.
 *
 * Standalone, and taking what it needs rather than reading a walker's cursors, because it is the half of
 * this check that has to be exactly right - a wrong field order here fails every payload in a sound log
 * and stamps the whole report inaccurate. Read on its own, it can be compared against the producer
 * without also reading a loop. */
function filteredTraversalHistoryRebuild(body: Record<string, unknown>, level: number | undefined, maze: RoundMaze): string {
  // What Tapoo calls a cell. Nested because the rebuild is the only thing that asks: this is one field
  // of the string being reproduced, not a fact about the maze anything else wants.
  //
  // start-cell and target-cell override the structural type - cell 0,0 of the snapshot log has one exit
  // and would read dead-end, where Tapoo writes start-cell.
  const cellTypeOf = (cell: CellKey): string => {
    if (cell === maze.startCell) return "start-cell";
    if (cell === cellKeyFromLogged(maze.destinationCell)) return "target-cell";
    const open = maze.exits.get(cell)?.size ?? 0;
    if (open <= 1) return "dead-end";
    return open === 2 ? "corridor" : "junction";
  };

  const history = asArray(body.filteredTraversalHistory).map(asRecord).map((record) => {
    const key = cellKeyFromLogged(record.cell) ?? "0,0";
    const openMoves: Record<string, unknown> = {};
    for (const [move, status] of statusesFromLogged(record.openMoves)) {
      openMoves[move] = {...cellFromKey(stepFrom(key, move)), visitStatus: status};
    }
    return {
      playerName: record.playerName,
      cell: cellFromKey(key),
      cellType: cellTypeOf(key),
      openMoves,
    };
  });

  return JSON.stringify({
    level,
    currentCell: cellFromLogged(body.currentCell) ?? {row: 0, col: 0},
    destinationCell: maze.destinationCell,
    historyWindowRadius: maze.historyWindowRadius,
    filteredTraversalHistory: history,
  });
}

// traversalPayloadWarnings verifies that every get_maze_structure result arrived intact.
//
// The replay's visit-status overlay is drawn from these payloads with nothing in between to question
// them, so a damaged payload reaches the grid as an overlay that looks exactly as certain as a correct
// one. Hence checking them here.
//
// The checking itself is filteredTraversalHistoryRebuild above, which says why a stored payload cannot
// simply be hashed. What this function does is walk a round, keep the facts that reconstruction needs,
// and decide for each payload whether it can be checked at all - the third outcome, and the one worth
// reading: a payload nothing could verify is not a payload that passed.
//
// Given one round's entries, by parseRound, and still running a cursor rather than assuming a single
// maze: a group keyed game/level holds a replay of that level too, and each opening resets the facts the
// reconstruction needs.
//
// Run when the round is opened, not when its maze is drawn, so a damaged payload is reported once above
// the report instead of being found by whoever happens to scrub to the turn holding it.
function traversalPayloadWarnings(entries: LogEntry[]): {warnings: LogWarning[]; check: ValidationCheck} {
  const warnings: LogWarning[] = [];

  let exits: OpenCellExits | null = null;
  let startCell: CellKey | null = null;
  let destinationCell: unknown = null;
  let historyWindowRadius: unknown = null;
  let verified = 0;
  let damaged = 0;
  let unverifiable = 0;
  let firstDamaged: string | null = null;

  for (const entry of entries) {
    const details = asRecord(entry.details);

    if (entry.payload === LOG_EVENTS.levelStarted) {
      const built = mazeFromEncoded(details.maze as EncodedMaze);
      exits = built.ok ? built.maze.exits : null;
      startCell = cellFromGridPoint(asRecord(details.startPosition));
      destinationCell = details.destinationCell;
      historyWindowRadius = details.historyWindowRadius;
      continue;
    }

    for (const message of asArray(details.messages).map(asRecord)) {
      if (message.role !== "tool") continue;
      const text = messageText(message);
      if (!text) continue;

      // Is this a get_maze_structure result at all? Decided before anything is counted, because a round
      // carries three tools' results and only this one is reconstructable. Counting the other two as
      // "not checkable" reads as a gap in the checking when they are simply not this check's business:
      // it would report 32 unverifiable payloads on a log where every payload this check covers verified.
      let payload: unknown;
      try {
        payload = JSON.parse(text.content);
      } catch {
        continue;
      }
      const body = asRecord(payload);
      if (!Array.isArray(body.filteredTraversalHistory)) continue;

      const {checksum} = text;
      // Verify only when the round supplied every input the reconstruction needs.
      //
      // The checksum covers the payload Tapoo sent, which carries destinationCell and
      // historyWindowRadius - and compaction strips both, so they can only come from the round's
      // "Agent level started." entry. Without one, JSON.stringify simply omits the keys and the rebuilt
      // text is a different string, so *every* payload in the round would fail and an otherwise sound
      // log would be stamped inaccurate from top to bottom.
      //
      // A missing input is not evidence of damage. It means we cannot check, which is silence.
      if (
        checksum === null ||
        exits === null ||
        destinationCell === null ||
        destinationCell === undefined ||
        typeof historyWindowRadius !== "number"
      ) {
        unverifiable += 1;
        continue;
      }

      // The guard above is what proves these four, so the value is built from them here rather than
      // being threaded through the walk.
      const rebuilt = filteredTraversalHistoryRebuild(body, entry.level, {
        exits, startCell, destinationCell, historyWindowRadius,
      });

      if (fnv1a64Checksum(rebuilt) === checksum) {
        verified += 1;
      } else {
        damaged += 1;
        firstDamaged ??= `turn ${entry.turn ?? "?"} of game ${entry.game ?? "?"} level ${entry.level ?? "?"}`;
      }
    }
  }

  if (damaged > 0) {
    // Inaccurate, not incomplete: the maze still draws, and it draws visit colours taken from a payload
    // that does not match what Tapoo says it sent. A reader would have no way to tell.
    warnings.push({
      impact: "inaccurate",
      message:
        damaged === 1
          ? `A maze-structure payload at ${firstDamaged ?? "an unknown turn"} does not match its checksum, so the visit colours on the replay may not be what the agent was shown.`
          : `${damaged} maze-structure payloads do not match their checksums, the first at ${firstDamaged ?? "an unknown turn"}, so the visit colours on the replay may not be what the agent was shown.`,
    });
  }

  return {warnings, check: traversalCheck(verified, damaged, unverifiable)};
}

/** How the traversal reconstruction reports itself when nothing is wrong.
 *
 * Nothing verified and something skipped is `unchecked`, not `passed`: the round did not record what
 * the reconstruction needs, so the visit colours on its replay are unvouched-for. That is the case this
 * summary exists to make visible - before it, a round that verified all 16 payloads and a round that
 * could attempt none both showed the same silence. */
function traversalCheck(verified: number, damaged: number, unverifiable: number): ValidationCheck {
  const name = "Traversal payloads";
  const scope = "round" as const;
  const skipped = unverifiable === 0 ? "" : `, ${formatCount(unverifiable)} not checkable`;
  const results = "get_maze_structure results";
  const total = verified + damaged;

  if (damaged > 0) {
    return {
      name,
      scope,
      outcome: "failed",
      detail: `${formatCount(damaged)} of ${formatCount(total)} ${results} did not match the checksum Tapoo stamped on them${skipped}`,
    };
  }
  if (verified === 0) {
    return {
      name,
      scope,
      outcome: "unchecked",
      detail:
        unverifiable === 0
          ? "the round carried no checksummed get_maze_structure results"
          : `${formatCount(unverifiable)} ${results} carried no checksum, or the round never recorded the destination cell and history window a reconstruction needs`,
    };
  }
  return {
    name,
    scope,
    outcome: "passed",
    detail: `${formatCount(verified)} of ${formatCount(total)} ${results} reconstructed byte-exactly${skipped}`,
  };
}

/** How a round names itself in a warning. The entries all belong to one round, so any of them can say
 * which - and the ones that carry the ids are the round's own boundaries. */
const roundName = (entries: LogEntry[]): string => {
  const named = entries.find((entry) => typeof entry.game === "number" || typeof entry.level === "number");
  return `Game ${named?.game ?? "-"} level ${named?.level ?? "-"}`;
};

// How a downloaded log shortens a repeated string: the first 25 characters and an ellipsis.
//
// Tapoo writes each system prompt, user message and tool description in full the first time it appears
// in a round and stubs every later appearance, because they repeat on every request and a real log has
// hundreds. The checksum beside a stub is of the *full* text, so a stub cannot be hashed - but it can
// still be checked against the full text logged earlier under the same checksum.
const COMPACT_HEAD = 25;

/** How the harness opens a warning, and the only way one is told apart.
 *
 * The warning reaches the model in one of two shapes, decided by the provider:
 *
 *   Ollama and OpenAI take a second user message, so the warning is appended after the tool results and
 *   the turn's instruction is left alone. Verified against a real request.
 *
 *   Anthropic allows only one user message per request, so the warning is merged into the instruction
 *   instead. Not verified: no Anthropic log has been read, the same gap assistantMessage records for its
 *   own Anthropic branch.
 *
 * Which is why this is a *contains* and not a startsWith. Appended, the warning opens with this word;
 * merged, it sits after the instruction, and a prefix test would report "no user warnings detected" on a
 * log that plainly has them. Searching the whole text catches both.
 *
 * The cost is that an instruction quoting this word verbatim would be miscounted as a warning. No text in
 * the capture contains it - the instruction has no form of the word, and the only "warning" anywhere is
 * lowercase and inside a system prompt, which is not searched.
 *
 * Position was the other candidate - "any user message after the first" - and it cannot see a merged
 * warning at all, because there is only ever one message to look at.
 *
 * If Tapoo rewords the opener, this row drops to "no user warnings detected" on a log that has them. That
 * is the failure mode to watch, and the reason a warning arriving trimmed is counted as unvalidated rather
 * than skipped: a row quietly reporting none is worse than one reporting something it could not check. */
const WARNING_PREFIX = "Warning:";
const COMPACT_TAIL = "...";
const compacted = (full: string): string => `${full.slice(0, COMPACT_HEAD)}${COMPACT_TAIL}`;

/** How many distinct system prompts one round can honestly carry.
 *
 * Tapoo rewrites the agent's persona as its traversal speed moves between brackets, and there are four
 * forms: the opening Default - "you start this level primed for success", before any speed has been
 * measured - and then Trailblazer, Navigator and Backtracker, one per bracket. They are set out at
 * https://dmigwi.github.io/tapoo/prompts.html.
 *
 * So a round has at most four distinct system-prompt checksums. A fifth is not a slow agent or a long
 * round; it means this file and the producer disagree about how many personas exist, and every count
 * here that assumes four is then describing something else. The snapshot log carries three, of which
 * only the opening Default is logged in full - the later two are compacted well past the word naming
 * the persona, so which brackets they are is not readable from the log. */
const PERSONA_FORMS = 4;

/** What a checksummed text was, which decides which row counts it. */
type TextKind = "persona" | "warning" | "text";

// promptWarnings checks that a round told the agent one consistent story.
//
// Three questions, and only one of them is "did the prompt change":
//
// **A tool's description must not change within a round.** Every appearance of a tool carries a
// description_checksum, and a round where one tool has two of them gave the agent two different
// accounts of the same tool - so its turns were not answering the same instructions, and comparing
// them across the round compares two experiments.
//
// **Text logged in full must match the checksum beside it.** A prompt and a tool description are logged
// verbatim the first time they appear in a round, so unlike a tool *result* - which is compacted before
// it is written, and which traversalPayloadWarnings reconstructs - this one can simply be hashed. All
// five in the snapshot log do.
//
// **Text logged as a stub can only be checked against itself.** Later appearances are trimmed to
// COMPACT_HEAD characters and an ellipsis, so hashing them is meaningless; what they must still be is
// the truncation of the full text logged earlier under the same checksum.
//
// The *system prompt* is deliberately not held to one-per-round. It changes mid-round by design: it
// opens "You are Katara, and you start this level primed for success" and is rewritten as the player's
// speed class changes, so a real 16-turn round carries three. Requiring one prompt per round would put
// an accuracy warning on every clean log.
//
// Tool *results* are excluded here for the same reason they are hashed elsewhere: their content is
// compacted rather than truncated, so it neither hashes nor ends in an ellipsis, and mistaking that for
// damage would warn on every log ever written.
function promptWarnings(entries: LogEntry[], round: string): {warnings: LogWarning[]; checks: ValidationCheck[]} {
  const warnings: LogWarning[] = [];
  const toolSums = new Map<string, Set<string>>();
  // Every checksummed text, with what it was: the consistency warning below is about bytes and covers
  // all of them, while the repeat counts are about one population and exclude personas - see note.
  const byChecksum = new Map<string, Array<{text: string; kind: TextKind}>>();
  const personas = new Set<string>();
  let personaAppearances = 0;
  // What the harness told the model when it had to warn it. Its own population, for the same reason the
  // personas are: a round where the model was warned forty times answered under conditions a clean round
  // did not, and that is a number a reader wants rather than something to find by reading turns.
  let userWarnings = 0;
  let userWarningsVerified = 0;
  let hashed = 0;
  let damaged = 0;
  let stubs = 0;

  /** Records one checksummed text.
   *
   * A trimmed persona is left out of the repeat population entirely: it is not a repeat of a text this
   * round logged, it is the next persona in a sequence Tapoo rewrites as the player's speed class changes,
   * and it is never logged in full at all. Counted as a repeat it produced 30 appearances with nothing to
   * compare them to, which reads as a shortfall in a check rather than as the persona sequence the Agent
   * personas row exists to report.
   *
   * A system prompt logged in full is still hashed here. That one is a claim the log makes about its own
   * bytes, and it can be wrong. */
  const note = (checksum: string, text: string, kind: TextKind): void => {
    byChecksum.set(checksum, [...(byChecksum.get(checksum) ?? []), {text, kind}]);

    // Trimmed text cannot be hashed, and a full text that happens to end in an ellipsis is only skipped
    // - the heuristic errs towards checking less, never towards warning wrongly.
    if (text.endsWith(COMPACT_TAIL)) {
      // A trimmed warning is counted and left unvalidated rather than dropped: it has never been seen, and
      // if it starts happening the row should say so instead of reporting a smaller total.
      if (kind === "warning") userWarnings += 1;
      if (kind === "text") stubs += 1;
      return;
    }

    // A warning is hashed by its own row, not by the one above: counted in both, a round with four of them
    // would report the same four texts twice and leave a reader deciding whether the rows agree.
    if (kind === "warning") {
      userWarnings += 1;
      if (fnv1a64Checksum(text) === checksum) userWarningsVerified += 1;
      return;
    }
    if (fnv1a64Checksum(text) === checksum) hashed += 1;
    else damaged += 1;
  };

  for (const entry of entries) {
    if (entry.payload !== LOG_EVENTS.request) continue;
    const details = asRecord(entry.details);

    // One request can carry two user messages. A warned request holds the turn's instruction and, appended
    // after the tool results, the warning itself - so `role: "user"` is not one message per request and
    // nothing here may treat it as one. It also carries `agentMode: "warned"`, which is not read: the text
    // says what the model was actually told, where the mark only says that something was.

    for (const message of asArray(details.messages).map(asRecord)) {
      // Not a tool result: that is a compacted payload, checked by reconstruction rather than by hash.
      //
      // And nothing without both halves of a checksummed text - messageText proves them, here and for the
      // reconstruction above, so what a readable message is has one definition.
      //
      // Dropping a text with no checksum loses nothing this can check, and nothing trimmed either: every
      // trimmed text in the capture carries one - all 107, across system prompts, user messages and tool
      // descriptions, no exception. The checksum-less ones are all untrimmed: the 16 assistant messages,
      // which are the model's own tool calls, and 32 of the 48 tool results, only get_maze_structure
      // carrying one.
      //
      // That is what makes the repeat denominator trustworthy: "76 of 76" is every trimmed text this round
      // logged outside the personas, not merely the ones that happened to arrive checkable. A trimmed text
      // with no checksum would be unverifiable *and* uncounted, the one shape this cannot report - it has
      // never appeared, and if the producer starts writing one it will need a row of its own.
      if (message.role === "tool") continue;
      const text = messageText(message);
      if (!text || text.checksum === null) continue;

      // Every other message is offered to note, which keeps the ones carrying a checksum. Three roles
      // reach it:
      //
      //   system - the persona, counted again below.
      //   user   - the turn's instruction, and on a warned-mode request a second user message holding the
      //            warning itself. That one is appended rather than merged, and logged in full every time
      //            rather than trimmed, because warnings are rare and each says something different.
      //   assistant - the model's own tool calls, which carry no content_checksum at all and so are
      //            dropped by the guard above. Nothing was shown to the agent here to check.
      //
      // A loop that read only system prompts would drop the user messages from both rows above - 32 of the
      // snapshot's texts.
      // A warning is a user message carrying WARNING_PREFIX, wherever in the text it falls - see the
      // constant for the two shapes that puts it in different places. Logged in full every time rather
      // than trimmed, because warnings are rare and each says something different.
      const isPersona = message.role === "system";
      const isWarning = message.role === "user" && text.content.includes(WARNING_PREFIX);
      note(text.checksum, text.content, isPersona ? "persona" : isWarning ? "warning" : "text");

      // Past here is the persona count, and nothing else is one. The persona travels in the system prompt,
      // and a user message carries none - not because there is only ever one of them, since a warned
      // request appends a second, but because what they say is the turn's instruction rather than who the
      // agent is being told to be.
      if (!isPersona) continue;

      // Appearances as well as distinct prompts, because this row owns the whole population: three
      // personas over thirty-two turns and three over three are different rounds, and nothing else in the
      // summary says how often each was seen.
      personas.add(text.checksum);
      personaAppearances += 1;
    }

    for (const tool of asArray(details.tools).map(asRecord)) {
      const name = asTrimmedText(tool.name);
      const checksum = tool.description_checksum;
      if (typeof checksum !== "string") continue;
      if (typeof tool.description === "string") note(checksum, tool.description, "text");
      if (!name) continue;
      toolSums.set(name, new Set([...(toolSums.get(name) ?? []), checksum]));
    }
  }

  for (const [name, sums] of toolSums) {
    if (sums.size < 2) continue;
    // Inaccurate, not incomplete: nothing is missing. The round's tool-use verdicts compare turns that
    // were working from different descriptions of the same tool.
    warnings.push({
      impact: "inaccurate",
      message:
        `${round} describes the tool ${name} ${sums.size} different ways, so its turns did not all see ` +
        "the same instructions and the tool-use answers compare turns that were told different things.",
    });
  }

  if (personas.size > PERSONA_FORMS) {
    // Inaccurate rather than incomplete: nothing is missing. What is wrong is this file's model of the
    // producer, and anything downstream that reasons about personas is reasoning from the wrong number.
    warnings.push({
      impact: "inaccurate",
      message:
        `${round} carries ${personas.size} distinct system prompts, but Tapoo defines ${PERSONA_FORMS} ` +
        "agent personas (Default, Trailblazer, Navigator, Backtracker). Either the persona set has " +
        "changed - see https://dmigwi.github.io/tapoo/prompts.html - or the prompt is varying for some " +
        "reason this analyzer does not model.",
    });
  }

  if (damaged > 0) {
    const desc = "so what the agent was shown is not what this log records."
    warnings.push({
      impact: "inaccurate",
      message:
        damaged === 1
          ? `${round} carries a prompt or tool description that does not match its own checksum, ${desc}`
          : `${round} carries ${damaged} prompts or tool descriptions that do not match their own checksums, ${desc}`,
    });
  }

  // A stub whose checksum the round never carried in full cannot be checked at all - and that is
  // ordinary rather than damage: Tapoo logs a prompt in full once and stubs every later appearance, so
  // a prompt that changes mid-round is only ever stubbed. Counted, so the summary can say how much of
  // the round's text was actually vouched for.
  let unmatched = 0;
  for (const [checksum, recorded] of byChecksum) {
    const texts = recorded.map((one) => one.text);
    const full = texts.reduce((longest, text) => (text.length > longest.length ? text : longest), "");
    if (full.endsWith(COMPACT_TAIL)) {
      // Personas excluded for the reason note gives: they are the only texts Tapoo never logs in full,
      // and counting them here made an ordinary sequence read as a shortfall in a check.
      unmatched += recorded.filter((one) => one.kind !== "persona").length;
      continue;
    }
    if (texts.every((text) => text === full || text === compacted(full))) continue;
    warnings.push({
      impact: "inaccurate",
      message:
        `${round} logs two different prompts or tool descriptions under one checksum (${checksum}), ` +
        "so what the agent was shown cannot be recovered from this log.",
    });
  }

  const drifted = [...toolSums.values()].filter((sums) => sums.size > 1).length;
  const checks: ValidationCheck[] = [
    promptTextCheck(hashed, damaged),
    trimmedRepeatCheck({matched: stubs - unmatched, unmatched}),
    {
      name: "Tool descriptions",
      scope: "round",
      outcome: toolSums.size === 0 ? "unchecked" : drifted > 0 ? "failed" : "passed",
      detail:
        toolSums.size === 0
          ? "the round declared no tools"
          : drifted > 0
            ? `${formatCount(drifted)} of ${formatCount(toolSums.size)} declared tools were described more than one way during the round`
            : `${formatCount(toolSums.size)} declared tools, each described one way throughout the round`,
    },
    {
      name: "Agent personas",
      scope: "round",
      outcome: personas.size === 0 ? "unchecked" : personas.size > PERSONA_FORMS ? "failed" : "passed",
      detail:
        personas.size === 0
          ? "the round carried no system prompt"
          : `${formatCount(personas.size)} distinct system prompt${personas.size === 1 ? "" : "s"} across ` +
            `${formatCount(personaAppearances)} appearance${personaAppearances === 1 ? "" : "s"}, of the ` +
            `${formatCount(PERSONA_FORMS)} personas Tapoo defines`,
    },
    // Beside the personas: who the agent was told to be, then what it was told off for.
    userWarningCheck(userWarnings, userWarningsVerified),
  ];

  return {warnings, checks};
}

/** How the prompt and tool-description texts logged in full report themselves.
 *
 * Only the texts this round can actually hash: logged verbatim, with a checksum beside them. The
 * repeats - logged as stubs, and never hashable - are their own check below, because they are a
 * different population answering a different question.
 */
function promptTextCheck(hashed: number, damaged: number): ValidationCheck {
  const name = "Prompts and tool descriptions";
  const scope = "round" as const;

  if (damaged > 0) {
    return {
      name,
      scope,
      outcome: "failed",
      detail:
        `${formatCount(damaged)} of ${formatCount(hashed + damaged)} texts logged in full did not match their own checksums`,
    };
  }
  if (hashed === 0) {
    return {name, scope, outcome: "unchecked", detail: "the round carried no prompt or description logged in full"};
  }
  return {
    name,
    scope,
    outcome: "passed",
    detail: `${formatCount(hashed)} of ${formatCount(hashed)} texts logged in full hashed to the checksum beside them`,
  };
}

/** What the trimmed repeats were compared against, and how many of each population there were. */
type RepeatTally = {
  /** Stub appearances whose checksum the log also carries a full text under. */
  matched: number;
  /** Stub appearances whose checksum has no full text anywhere in the log. */
  unmatched: number;
};

/** How many warnings the harness gave the model, and whether the log's own bytes bear them out.
 *
 * Its own row, beside Agent personas, because it is its own population and its size is the finding: a
 * round where the model was warned forty times answered its turns under conditions a clean round did not,
 * and that is not something a summary should leave a reader to count off the turns.
 *
 * Hashed here and nowhere else. A warning is logged in full every time - warnings are rare and each says
 * something different, so there is never an earlier copy to trim it against - which makes it checkable the
 * simple way, and counting it in the row above as well would report the same texts twice.
 *
 * A round with none is `passed` and says so. Nothing failed to run - the round was searched and there is
 * nothing to find - and "not checked" would read as a fault in the report on the ordinary, good case. */
function userWarningCheck(warnings: number, verified: number): ValidationCheck {
  const name = "User warnings";
  const scope = "round" as const;

  if (warnings === 0) {
    return {name, scope, outcome: "passed", detail: "0 of 0 - no user warnings detected"};
  }
  return {
    name,
    scope,
    outcome: verified === warnings ? "passed" : "failed",
    detail:
      `${formatCount(verified)} of ${formatCount(warnings)} user warnings validated against their checksums`,
  };
}

/** How the trimmed, checksummed repeats report themselves.
 *
 * A repeat is logged trimmed - the first COMPACT_HEAD characters and an ellipsis - with the checksum of
 * the untrimmed text beside it, so it can only be checked against the full text logged under that same
 * checksum. The check is over exactly those, and it counts appearances and nothing else.
 *
 * It does not say how many distinct checksums stand behind them, though it knows. The texts that go
 * uncompared here are system prompts - Tapoo trims a persona it never logged in full - and how many
 * distinct system prompts a round carried is what the Agent personas check above reports. Two rows
 * counting one population from different angles is a reader working out whether they disagree.
 *
 * A trimmed repeat whose full text the log does not carry is not a failure and not a check that did not
 * run. It is the producer compacting a text it never logged in full - in the v2.5.1 capture, 2 of the 7
 * distinct trimmed checksums have no full text in the file at all, across 30 appearances - so there is
 * nothing here to compare and nothing wrong with that.
 *
 * Its own row all the same, because the population is not the one above it: those texts are logged in
 * full and hashed, these are compared against an earlier copy, and one row reporting both let whichever
 * number was larger speak for the other. */
function trimmedRepeatCheck({matched, unmatched}: RepeatTally): ValidationCheck {
  const name = "Trimmed checksummed repeats";
  const scope = "round" as const;
  const absentClause = unmatched === 0
    ? ""
    : `; ${formatCount(unmatched)} more stand for text no entry in this log carries in full, so there ` +
      "is nothing to compare them against";

  if (matched + unmatched === 0) {
    return {name, scope, outcome: "unchecked", detail: "the round carried no trimmed repeats"};
  }
  if (matched === 0) {
    return {
      name,
      scope,
      outcome: "unchecked",
      detail:
        `all ${formatCount(unmatched)} of this round's repeats stand for text no entry in this log ` +
        "carries in full, so none of them could be compared",
    };
  }
  return {
    name,
    scope,
    outcome: "passed",
    detail:
      `${formatCount(matched)} of ${formatCount(matched)} repeats matched the full text logged under the ` +
      `same checksum${absentClause}`,
  };
}

/** agentSeatLabel names a seat the way both the report and the replay say it.
 *
 * One function because two places render it, and a seat called something different in each would read
 * as two seats. Prefers the seat the log stated; falls back to the position it acted in.
 *
 * The seat alone where no turn named the player: a request may state its seat and leave the name to the
 * decorated label, and a label that resolves to nothing leaves a seat that plainly played and has no
 * name. "Agent at Seat 2" is what is known about it; a leading separator with nothing before it is not. */
export const agentSeatLabel = (agent: AgentSummary, index: number): string => {
  const seat = `Agent at Seat ${agent.seatId ?? index + 1}`
  return agent.name === "" ? seat : `${agent.name} \u00b7 ${seat}`
}


/** The per-turn settings a seat can be found to have changed, and how each is reported.
 *
 * `values: false` for endpoints alone, and not for brevity. This detail is rendered into a table cell,
 * and an endpoint may carry `user:pass@host` - the thing withoutCredentials exists to keep out of the
 * DOM. That function lives in report-adapters, which imports this module, so it cannot be reached from
 * here without closing a cycle. The count says drift happened; the Agents table shows the addresses
 * themselves, stripped. */
const DRIFTABLE: Array<{label: string; values: boolean; of: (agent: AgentSummary) => readonly string[]}> = [
  {label: "models", values: true, of: (agent) => agent.models},
  {label: "APIs", values: true, of: (agent) => agent.apis},
  {label: "reasoning efforts", values: true, of: (agent) => agent.reasoningEfforts},
  {label: "endpoints", values: false, of: (agent) => agent.endpoints},
];

/** How a seat is named in a finding, where there is no roster index to fall back on. */
const seatName = (agent: AgentSummary): string =>
  agent.name === "" ? `Seat ${agent.seatId ?? "?"}` : agent.name;

/** What one seat changed, as clauses, or none where it held one of everything. */
function driftOf(agent: AgentSummary): string[] {
  return DRIFTABLE.filter((field) => field.of(agent).length > 1).map((field) => {
    const held = field.of(agent);
    const counted = `${formatCount(held.length)} ${field.label}`;
    return field.values ? `${counted} (${held.join(", ")})` : counted;
  });
}

/** seatRosterCheck reports whether the round's seats and players line up one to one.
 *
 * Tapoo seats one player per seat, so the two name the same thing and a log that disagrees with itself
 * cannot be attributed. Both directions are silent failures without this, and they fail differently:
 *
 *   One seat, two players. The second turn is credited to the first player - the seat matches, so the
 *   record is found and its name kept - and the other player's turn disappears into it. One row on the
 *   page, its cells and charge holding two agents' work.
 *
 *   One player, two seats. Two records with the same name, so the page shows the player twice, and
 *   anything that reads a seat by name reaches whichever comes first.
 *
 * Read off the turns rather than the summaries, because a summary is what the disagreement destroys: the
 * first case leaves one record with nothing about it out of place.
 *
 * Turns that state only one of the two say nothing here - a legacy log numbers no turn, and this check has
 * no opinion on it. */
export function seatRosterCheck(turns: readonly TurnSummary[]): ValidationCheck {
  const name = "Seat roster";
  const scope = "round" as const;
  const playersBySeat = new Map<number, Set<string>>();
  const seatsByPlayer = new Map<string, Set<number>>();

  for (const turn of turns) {
    const player = asTrimmedText(turn.playerName);
    if (turn.seatId === null || player === "") continue;
    (playersBySeat.get(turn.seatId) ?? playersBySeat.set(turn.seatId, new Set()).get(turn.seatId)!).add(player);
    (seatsByPlayer.get(player) ?? seatsByPlayer.set(player, new Set()).get(player)!).add(turn.seatId);
  }

  if (playersBySeat.size === 0) {
    return {name, scope, outcome: "unchecked", detail: "no turn stated both a seat and a player"};
  }

  const findings = [
    ...[...playersBySeat].filter(([, players]) => players.size > 1).map(
      ([seatId, players]) => `seat ${seatId} played as ${formatCount(players.size)} players (${[...players].join(", ")})`,
    ),
    ...[...seatsByPlayer].filter(([, seatIds]) => seatIds.size > 1).map(
      ([player, seatIds]) => `${player} played from ${formatCount(seatIds.size)} seats (${[...seatIds].join(", ")})`,
    ),
  ];

  if (findings.length > 0) {
    return {
      name,
      scope,
      outcome: "failed",
      detail: `${findings.join("; ")} - a seat is one player and a player is one seat, so these turns cannot be told apart`,
    };
  }

  return {
    name,
    scope,
    outcome: "passed",
    detail:
      playersBySeat.size === 1
        ? "one seat, one player, throughout"
        : `${formatCount(playersBySeat.size)} seats, one player each, throughout`,
  };
}

/** agentSettingsCheck reports whether each seat answered under one setup for the whole round.
 *
 * A seat that changed model, provider, endpoint or effort mid-round was not one experiment: its turns
 * before and after are not comparable, and a verdict drawn across them compares two setups. The same
 * argument the tool-description check makes, and the reason AgentSummary holds lists - a list longer
 * than one *is* the finding, so nothing is counted twice to reach it.
 *
 * Every drifted seat is named, and every setting each one changed, with the values it changed between.
 * A count alone - "ran 2 different settings" - told a reader that something moved and left them to find
 * what in the Agents table, and reporting only the first seat hid the rest of a finding that is about
 * comparability: a round with two unstable seats is not one bad seat.
 *
 * Stated as a replication problem, because that is the consequence a reader can act on: there is no one
 * setup they could run again to get this profile back, and the row names the settings they would have to
 * choose between to try.
 *
 * Only possible because settings are read per turn. A roster declared once at the start of a round
 * could not contradict itself, so there would be nothing here to check. */
export function agentSettingsCheck(agents: readonly AgentSummary[]): ValidationCheck {
  const name = "Agent settings";
  const scope = "round" as const;
  const stated = agents.filter(
    (agent) =>
      agent.models.length + agent.apis.length + agent.endpoints.length + agent.reasoningEfforts.length > 0,
  );
  if (stated.length === 0) {
    return {name, scope, outcome: "unchecked", detail: "the round recorded no model, provider or effort"};
  }

  const drifted = stated.map((agent) => ({agent, changed: driftOf(agent)}))
    .filter(({changed}) => changed.length > 0);

  if (drifted.length > 0) {
    return {
      name,
      scope,
      outcome: "failed",
      detail:
        `${drifted.map(({agent, changed}) => `${seatName(agent)} ran ${changed.join(" and ")}`).join("; ")}` +
        ` - this makes it hard to replicate this report output/profile.`,
    };
  }

  return {
    name,
    scope,
    outcome: "passed",
    detail:
      stated.length === 1
        ? "one seat, on one model, endpoint and reasoning effort throughout"
        : `${formatCount(stated.length)} seats, each on one model, endpoint and reasoning effort throughout`,
  };
}

/** parseRound reads one round's entries: its maze, and whether what the log carries about that
 * round arrived intact.
 *
 * The round half of the contract. parseTapooLogText answers for the file - is this a Tapoo export, are
 * entries readable - and this answers for a round: what its maze decodes to, and whether every
 * get_maze_structure result still hashes to the `content_checksum` Tapoo stamped on it before
 * compaction. Both are statements about *this* round, so they travel with it instead of pooling into a
 * list that names the log; a caveat about game 2 sitting above game 1's report told a reader nothing
 * they could act on and hid game 1's own.
 *
 * Called per round, and only for a round somebody is reading. The checksum reconstruction is the
 * expensive half of reading a log - a JSON round-trip and a byte-at-a-time hash per tool result - and a
 * file of fourteen rounds was paying all fourteen to show one.
 *
 * A maze that is absent or will not decode is *returned*, not warned about. A warning as well put one
 * fault in two places and made the round look twice as broken: the replay already says it where the
 * reader is looking at the empty space, and says it better - what is missing, what it costs, and that
 * the rubric verdicts still stand.
 *
 * The verdicts do stand either way: no rubric question reads this payload. The corridor questions
 * answer from the exits the log's own tool results confirmed. */
export function parseRound(entries: LogEntry[]): ParsedRound {
  let maze: MazeResult | null = null;

  // The first level-started maze, decoded with the round's own start and destination - the same two the
  // replay decodes with, so what comes back here is what the replay would build.
  //
  // Per entry, not once, because a group keyed game/level holds a replay of that level too and each
  // opening carries its own maze. The first is the one buildPlayedRounds reads, so it is the one returned.
  for (const entry of entries) {
    if (entry.payload !== LOG_EVENTS.levelStarted) continue;
    if (maze !== null) break;

    const details = asRecord(entry.details);
    if (details.maze === null || details.maze === undefined) continue;

    maze = mazeFromEncoded(details.maze as EncodedMaze, {
      startCell: cellFromGridPoint(asRecord(details.startPosition)),
      destinationCell: cellKeyFromLogged(details.destinationCell),
    });
  }

  const prompts = promptWarnings(entries, roundName(entries));
  const traversal = traversalPayloadWarnings(entries);

  return {
    maze,
    warnings: [...prompts.warnings, ...traversal.warnings],
    checks: [mazeCheck(maze), ...prompts.checks, traversal.check],
  };
}

/** How the decoded maze reports itself.
 *
 * One check rather than four, though mazeFromEncoded verifies four things - the structure checksum,
 * that edges are one fewer than cells, the dead-end identity, and that a route from start to
 * destination exists. They fail as one result and the replay already prints the last two as proofs, so
 * naming them here is enough for a reader to know what "passed" covered. */
function mazeCheck(maze: MazeResult | null): ValidationCheck {
  const name = "Encoded maze";
  const scope = "round" as const;
  if (maze === null) {
    return {name, scope, outcome: "unchecked", detail: "the round carried no encoded maze"};
  }
  if (!maze.ok) {
    return {name, scope, outcome: "failed", detail: maze.error};
  }
  return {
    name,
    scope,
    outcome: "passed",
    detail: "structure checksum, acyclic-graph and dead-end proofs, and a navigable start-to-destination route",
  };
}

/** parseTapooLogText is the ingress point: every log the app reads enters here, and nothing else in
 * this module takes a log from outside.
 *
 * Text in, because text is what arrives - a fetch body, a paste, a file. Parsing the JSON and checking
 * the envelope are one operation here rather than two exported halves: nothing outside this function has
 * any use for the value between them, and a type declared to carry it would exist for no reader.
 *
 * Returns a discriminated result rather than throwing, because every failure here is reported to a
 * person - the app renders it beside the input the reader typed - and none of them is exceptional.
 *
 * Strict on identity (name, entry shape) and deliberately lenient on version: refusing an unrecognized
 * build would make the analyzer useless against exactly the logs most worth inspecting, those from a
 * Tapoo newer than this app. An unknown version analyzes, with a warning attached.
 *
 * Its successful output is the normalized shape every downstream query uses: name, version, mode,
 * downloadedAt and readable entries. What it does *not* do is index the turns or read a round: a turn span
 * belongs to the round it is in, and buildContext derives one per round from that round's own entries -
 * see parseRound. */
export function parseTapooLogText(text: unknown, {sourceUrl}: {sourceUrl?: string} = {}): LogTextResult {
  const trimmed = asTrimmedText(text);
  if (!trimmed) {
    return {ok: false, error: "Load a Tapoo agent-api log from an online JSON URL to begin."};
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    return {ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`};
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {ok: false, error: "Expected a Tapoo log export object at the top level."};
  }

  const envelope = value as Record<string, unknown>;

  if (envelope.name !== LOG_ENVELOPE_NAME) {
    return {
      ok: false,
      error: `Not a Tapoo log export: expected name "${LOG_ENVELOPE_NAME}", found ${JSON.stringify(envelope.name) ?? "nothing"}.`,
    };
  }

  if (!Array.isArray(envelope.entries)) {
    return {ok: false, error: "Tapoo log export is missing its `entries` array."};
  }

  const warnings: LogWarning[] = [];
  if (envelope.mode !== AGENT_API_MODE) {
    // Inaccurate rather than incomplete: every question is written for an agent-api round, so answering
    // them about some other mode produces verdicts, not correct ones.
    warnings.push({
      impact: "inaccurate",
      message: `Export mode is ${JSON.stringify(envelope.mode)}, not "${AGENT_API_MODE}". The behavior rubric only describes agent-api rounds.`,
    });
  }

  if (typeof envelope.version !== "string") {
    // Incomplete, not inaccurate: every verdict still stands, but the report cannot say which build
    // produced the behavior it describes, which is half of what makes it citable.
    warnings.push({
      impact: "incomplete",
      message: "Export carries no Tapoo version; results cannot be attributed to a build.",
    });
  }

  const entries = envelope.entries.filter(isLogEntry);
  const skipped = envelope.entries.length - entries.length;
  if (skipped > 0) {
    // Unreadable entries are stand-ins written by storage-logs.ts when a record fails to decode.
    // They are dropped rather than fatal: the surrounding round is still worth analyzing, but the
    // count has to surface, because it bounds how complete any "not observed" answer really is.
    warnings.push({
      // Inaccurate: the rubric answers NO on absent evidence, so evidence that was dropped rather than
      // never recorded can turn a YES into a NO without anything else looking wrong.
      impact: "inaccurate",
      message:
        skipped === 1
          ? "1 entry did not match the log entry shape and was skipped."
          : `${skipped} entries did not match the log entry shape and were skipped.`,
    });
  }

  if (entries.length === 0) {
    return {ok: false, error: "Tapoo log export contains no readable entries."};
  }

  // One walk over the responses, read by both the warning and the check below. They say the same two
  // numbers to different audiences - the warning that a verdict may be wrong, the check what was
  // verified - so a disagreement between them would be a contradiction on the same page.
  const responses = countResponses(entries);
  warnings.push(...unreadableResponseWarnings(responses));

  // Both true of every round in the file: an entry that fails the contract is dropped before rounds
  // exist, and the provider's response shape does not change between them.
  const checks: ValidationCheck[] = [
    {
      // Named for what it reads rather than for the contract it applies. "Entry shape" said nothing
      // about what a shape is or which entries were counted; every consumer of a log needs these three
      // fields, so the check says so and the count says what it counted.
      name: "Log entry fields",
      scope: "log",
      outcome: skipped > 0 ? "failed" : "passed",
      detail:
        skipped > 0
          ? `${formatCount(skipped)} of ${formatCount(envelope.entries.length)} log entries lacked a payload, a timestamp or a known log level, and were dropped`
          : `${formatCount(entries.length)} of ${formatCount(entries.length)} log entries carried a payload, a timestamp and a known log level`,
    },
    responseCheck(responses),
  ];

  // Only the export's own caveats; a round's are parseRound's.

  // v2.6.1 records runtime provenance on the envelope; preserve valid strings exactly as exported.
  const log: TapooLog = {
    name: envelope.name,
    platform: typeof envelope.platform === "string" ? envelope.platform : null,
    device: typeof envelope.device === "string" ? envelope.device : null,
    version: typeof envelope.version === "string" ? envelope.version : null,
    mode: typeof envelope.mode === "string" ? envelope.mode : null,
    downloadedAt: typeof envelope.downloadedAt === "string" ? envelope.downloadedAt : null,
    entries,
  };

  return {ok: true, source: sourceUrl ? {...log, sourceUrl} : log, warnings, checks};
}
