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
  GameRound,
  AgentSummary,
  LogWarning,
  MazeResult,
  Outcome,
  Turn,
  TurnSetup,
  ValidationCheck,
  AssistantMessage,
  ResponseUsage,
  LogEntry,
  LogTextResult,
  TapooLog,
} from "./types";

import {asArray, asRecord, asTrimmedText, fnv1a64Checksum, formatCount, isRecord} from "./utils";
import {indexLog} from "./log-index";
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
 * That offset lives on one line, inside this store, and nowhere else. It used to be a bare `- 1` beside
 * a plain Map, which meant every writer had to remember it and every reader had to trust that they had:
 * it was written `.get(turn + 1)` in one place, `reportedAt - 1` in another, and left out entirely in a
 * third, which is how the maze overlay came to draw its colours a turn behind the maze.
 *
 * `record` is the only way in and takes the turn that *carried* a payload; `get` is the only way out and
 * takes the turn it *covers*. A caller holding the offset separately is the bug this closes, so there is
 * no exported helper to hold.
 *
 * Turn 0's payload covers turn -1: there is no turn before the first, so that key holds the state the
 * round opened in and matches no turn. */
export function turnReports<T>(): TurnReports<T> {
  const byTurn = new Map<number, T>();

  return {
    record(reportingTurn, value, merge) {
      const turn = reportingTurn - 1;
      const existing = byTurn.get(turn);
      byTurn.set(turn, existing !== undefined && merge ? merge(existing, value) : value);
    },
    get: (turn) => byTurn.get(turn),
    // Sorted rather than trusted to insertion order: entries do arrive in recorded order today, but a
    // reader that walks them to a bound is relying on the ordering, not on the writer's habits.
    ascending: () => [...byTurn].sort(([a], [b]) => a - b),
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

// traversalPayloadWarnings verifies that every get_maze_structure result arrived intact.
//
// The replay's visit-status overlay is drawn from these payloads with nothing in between to question
// them, so a damaged payload reaches the grid as an overlay that looks exactly as certain as a correct
// one. Hence checking them here.
//
// `content_checksum` is fnv1a64Checksum of the content Tapoo sent, not of the compacted form the log
// keeps, so hashing the text on disk would never reproduce it. Verifying means rebuilding the original
// first, and every field that takes is either in the record itself or on the round's "Agent level
// started." entry.
//
// Verified byte-exact against a real export: the key order, the compact separators, and cellType's
// precedence are all as Tapoo writes them, and 8 of 8 checksummed results in the snapshot log reproduce.
//
// Given one round's entries, by parseGameRound, and still running a cursor rather than assuming a single
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

  const cellTypeOf = (cell: CellKey): string => {
    // start-cell and target-cell override the structural type: cell 0,0 of the snapshot log has one
    // exit and would read dead-end, and Tapoo writes start-cell.
    if (cell === startCell) return "start-cell";
    if (cell === cellKeyFromLogged(destinationCell)) return "target-cell";
    const open = exits?.get(cell)?.size ?? 0;
    if (open <= 1) return "dead-end";
    return open === 2 ? "corridor" : "junction";
  };

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
      if (message.role !== "tool" || typeof message.content !== "string") continue;

      // Is this a get_maze_structure result at all? Decided before anything is counted, because a round
      // carries three tools' results and only this one is reconstructable. Counting the other two as
      // "not checkable" read as a gap in the checking when they are simply not this check's business -
      // it reported 32 unverifiable payloads on a log where every payload this check covers verified.
      let payload: unknown;
      try {
        payload = JSON.parse(message.content);
      } catch {
        continue;
      }
      const body = asRecord(payload);
      if (!Array.isArray(body.filteredTraversalHistory)) continue;

      const checksum = message.content_checksum;
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
        typeof checksum !== "string" ||
        exits === null ||
        destinationCell === null ||
        destinationCell === undefined ||
        typeof historyWindowRadius !== "number"
      ) {
        unverifiable += 1;
        continue;
      }

      const history = body.filteredTraversalHistory.map(asRecord).map((record) => {
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

      const rebuilt = JSON.stringify({
        level: entry.level,
        currentCell: cellFromLogged(body.currentCell) ?? {row: 0, col: 0},
        destinationCell,
        historyWindowRadius,
        filteredTraversalHistory: history,
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
  const byChecksum = new Map<string, string[]>();
  const personas = new Set<string>();
  let hashed = 0;
  let damaged = 0;
  let stubs = 0;

  const note = (checksum: unknown, text: unknown): void => {
    if (typeof checksum !== "string" || typeof text !== "string") return;
    byChecksum.set(checksum, [...(byChecksum.get(checksum) ?? []), text]);
    // Trimmed text cannot be hashed, and a full text that happens to end in an ellipsis is only skipped
    // - the heuristic errs towards checking less, never towards warning wrongly.
    if (text.endsWith(COMPACT_TAIL)) {
      stubs += 1;
      return;
    }
    if (fnv1a64Checksum(text) === checksum) hashed += 1;
    else damaged += 1;
  };

  for (const entry of entries) {
    if (entry.payload !== LOG_EVENTS.request) continue;
    const details = asRecord(entry.details);

    for (const message of asArray(details.messages).map(asRecord)) {
      // Not a tool result: that is a compacted payload, checked by reconstruction rather than by hash.
      if (message.role === "tool") continue;
      note(message.content_checksum, message.content);
      // The persona travels in the system prompt, which is why the count is taken here and not from the
      // user message: that one is the same fixed instruction on every request of the round - one
      // checksum across all 32 in the snapshot - so it carries no persona to count.
      if (message.role === "system" && typeof message.content_checksum === "string") {
        personas.add(message.content_checksum);
      }
    }

    for (const tool of asArray(details.tools).map(asRecord)) {
      const name = asTrimmedText(tool.name);
      const checksum = tool.description_checksum;
      note(checksum, tool.description);
      if (!name || typeof checksum !== "string") continue;
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
  for (const [checksum, texts] of byChecksum) {
    const full = texts.reduce((longest, text) => (text.length > longest.length ? text : longest), "");
    if (full.endsWith(COMPACT_TAIL)) {
      unmatched += texts.length;
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
    promptTextCheck(hashed, damaged, stubs - unmatched, unmatched),
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
          : `${formatCount(personas.size)} distinct system prompts, of the ${formatCount(PERSONA_FORMS)} personas Tapoo defines`,
    },
  ];

  return {warnings, checks};
}

/** How the prompt and tool-description texts report themselves.
 *
 * Two populations, and the summary has to keep them apart. Text logged in full is hashed against the
 * checksum beside it. Text logged as a stub cannot be hashed, only compared with the full text under the
 * same checksum - and where the round never carried that full text, it cannot be checked at all. The
 * snapshot log is mostly that last case, which is exactly why a bare "passed" would overstate it. */
function promptTextCheck(hashed: number, damaged: number, matched: number, unmatched: number): ValidationCheck {
  const name = "Prompts and tool descriptions";
  const scope = "round" as const;
  const parts = [
    hashed > 0 ? `${formatCount(hashed)} texts logged in full and hashed against their checksums` : "",
    matched > 0 ? `${formatCount(matched)} shortened repeats matched the full text they stand for` : "",
    unmatched > 0 ? `${formatCount(unmatched)} shortened repeats whose full text this round never carried` : "",
  ].filter(Boolean);

  if (damaged > 0) {
    return {
      name,
      scope,
      outcome: "failed",
      detail: `${formatCount(damaged)} texts did not match their own checksums${parts.length > 0 ? `; ${parts.join(", ")}` : ""}`,
    };
  }
  if (hashed === 0 && matched === 0) {
    return {
      name,
      scope,
      outcome: "unchecked",
      detail: unmatched > 0 ? `${formatCount(unmatched)} shortened repeats whose full text this round never carried` : "the round carried no checksummed prompt or description",
    };
  }
  return {name, scope, outcome: "passed", detail: parts.join(", ")};
}

// --- The agents that played a round ---

/** agentsFromRound reads one round into one record per seat: what each was running, and what it did.
 *
 * A single pass, deliberately. The setup half and the performance half were once gathered in two places,
 * one of them a set of parallel arrays whose rows held together only by shared index, and neither could
 * answer "what was seat 2 running". One record per seat cannot come apart that way.
 *
 * A separate pass from parseGameRound, though they share this file. That one asks whether a round's
 * payloads arrived intact; this one asks who played and under what - different questions over the same
 * round, and a caller that wants one should not pay for the other.
 *
 * Takes the setup map rather than the whole Context: it reads one field, and a caller with turns and an
 * outcome should not have to build a rubric context to name the seats that played them.
 *
 * Seats are ordered by the seat the log stated, and by who acted first where it stated none. */
export function agentsFromRound(
  setupByTurn: ReadonlyMap<number, TurnSetup>,
  turns: readonly Turn[],
  outcome: Outcome | null,
): AgentSummary[] {
  const seats: AgentSummary[] = []

  // Two side tables keyed by the record itself rather than by a name, so nothing here has to agree with
  // anything else about what identifies a seat - seatFor below is the single answer to that.
  //
  // The echoes are held apart from what was declared. An echo drops the ":provider" suffix that says
  // where the model was served from - "gemma4" for a declared "gemma4:cloud", and on Hugging Face
  // "moonshotai/Kimi-K3" for "moonshotai/Kimi-K3:baseten" - so the declared name is the fuller of the two
  // and the one to report. This list is only consulted for a seat nothing declared a model for.
  const echoes = new Map<AgentSummary, string[]>()
  const entered = new Map<AgentSummary, Set<CellKey>>()

  const blank = (name: string, seatId: number | null): AgentSummary => {
    const seat: AgentSummary = {
      name,
      seatId,
      models: [],
      apis: [],
      endpoints: [],
      reasoningEfforts: [],
      uniqueCells: null,
      decayCharged: null,
      traversalSpeed: null,
    }
    seats.push(seat)
    return seat
  }
  const add = (list: string[], value: string | null): void => {
    if (value !== null && !list.includes(value)) list.push(value)
  }

  /** The seat a turn belongs to, by the stated seat where there is one and by name otherwise.
   *
   * Tapoo gives each seat one player and one id, so either identifies a seat on its own. The stated seat
   * is preferred because it is stated: it arrives on the request as a number, where the name arrives only
   * after resolveActingAgents has recovered it from a decorated label, which can fail - and a turn whose
   * recovery failed still says outright which seat played it.
   *
   * Falls back to the name because a log that states no seat is still the common case, and to null: a
   * turn with neither cannot be attributed, and guessing which seat it was is worse than saying nothing. */
  const seatFor = (seatId: number | null, name: string): AgentSummary | null => {
    if (seatId !== null) {
      const stated = seats.find((seat) => seat.seatId === seatId)
      // A record can be made before its name is known - a turn that states its seat and no name - so the
      // first turn to state one fills it in.
      if (stated) {
        if (stated.name === "" && name !== "") stated.name = name
        return stated
      }

      // The same seat, met earlier on a turn that named it without numbering it. Adopting the record
      // rather than opening a second one keeps a mixed round - some turns stating a seat, some not - as
      // one seat rather than two halves of one.
      const unnumbered = name === ""
        ? undefined
        : seats.find((seat) => seat.seatId === null && seat.name === name)
      if (unnumbered) {
        unnumbered.seatId = seatId
        return unnumbered
      }

      return blank(name, seatId)
    }

    if (name === "") return null
    return seats.find((seat) => seat.name === name) ?? blank(name, null)
  }

  // Every turn is played by exactly one seat, so a turn's setup, its charge and its cells are that
  // seat's. One pass for all three: they are joined by the same identity, and computing them apart is
  // what let a row be assembled out of two lists that agreed only by index.
  //
  // Unique cells *entered*, which is cells.slice(1) and not the whole walk. Turn.cells opens with
  // `before`, the cell the seat was already standing on, so the whole array is "where I was, then
  // everywhere I went". Counting all of it credits a seat with a cell it never moved into, and for turn 0
  // that cell is the start square - which Tapoo does not treat as the player's at all: its traversal
  // history labels the start "Self" on every reading, and its outcome record counts 17 unique cells where
  // the walk touches 18. For later turns the slice changes nothing, cells[0] already being in the set
  // from the turn before, so this is precisely the start-square correction and it is what makes the count
  // reconcile with playerUniqueCellsVisited.
  for (const turn of turns) {
    const setup = setupByTurn.get(turn.turn)
    // The seat off the turn, not off the setup map beside it. Both carry it - buildLevels fills one from
    // the other - but the replay reads the turn, and one authority is what keeps a trail's colour and
    // the row above it naming the same seat.
    const seat = seatFor(turn.seatId, turn.playerName ?? "")
    if (!seat) continue

    if (setup) {
      add(seat.models, setup.model)
      if (setup.echoedModel !== null) {
        const echoed = echoes.get(seat) ?? []
        add(echoed, setup.echoedModel)
        echoes.set(seat, echoed)
      }
      add(seat.apis, setup.api)
      add(seat.endpoints, setup.endpoint)
      add(seat.reasoningEfforts, setup.reasoning)
    }

    if (turn.decayCharged !== null) seat.decayCharged = (seat.decayCharged ?? 0) + turn.decayCharged

    const seen = entered.get(seat) ?? new Set<CellKey>()
    for (const cell of turn.cells.slice(1)) seen.add(cell)
    entered.set(seat, seen)
  }

  for (const [seat, seen] of entered) seat.uniqueCells = seen.size

  // The outcome names one seat - whoever made the final dash - and carries its speed and, in v2.5.1, the
  // only seatId the log states anywhere. Matched by that seat first, since that is the identity, and by
  // name only for the logs that state no seat on a turn. Older logs name nobody, and a round with a
  // single seat still has exactly one owner, so that case is attributed rather than dropped.
  const record = asRecord(outcome?.agent)
  const owner = asTrimmedText(record.playerName)
  const ownerSeatId = typeof record.seatId === "number" ? record.seatId : null

  // A seat the outcome names but no turn produced still played. That happens when a log's requests carry
  // nothing to attribute turns by, and dropping the seat there would report a round as having no agents
  // at all when the log plainly names one.
  const finisher =
    (ownerSeatId === null ? undefined : seats.find((seat) => seat.seatId === ownerSeatId)) ??
    (owner === "" ? undefined : seats.find((seat) => seat.name === owner)) ??
    (owner === "" && ownerSeatId === null
      ? seats.length === 1
        ? seats[0]
        : undefined
      : blank(owner, ownerSeatId))

  if (finisher) {
    const speed = Number(outcome?.traversalSpeed)
    if (Number.isFinite(speed)) finisher.traversalSpeed = speed
    // Only where the turns did not already state one: a request that names its own seat is the better
    // source, being per turn rather than per round.
    if (ownerSeatId !== null) finisher.seatId ??= ownerSeatId
    // The record declares a model the same way a request does, so it joins the declared list rather than
    // standing in for it.
    add(finisher.models, asTrimmedText(record.model) || null)
  }

  // The echo, only where nothing declared a model - better than reporting no model at all, and it names
  // the same model, just without the provider. Never alongside a declared name: the two are one model
  // named twice, and listing both would read as a seat that ran two models, which is exactly what
  // agentSettingsCheck reports as a finding.
  for (const seat of seats) {
    if (seat.models.length === 0) seat.models.push(...(echoes.get(seat) ?? []))
  }

  // A stated seat is the log's answer and beats the order they happened to act in.
  return seats.sort((first, second) =>
    first.seatId !== null && second.seatId !== null ? first.seatId - second.seatId : 0,
  )
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


/** agentSettingsCheck reports whether each seat answered under one setup for the whole round.
 *
 * A seat that changed model, provider, endpoint or effort mid-round was not one experiment: its turns
 * before and after are not comparable, and a verdict drawn across them compares two setups. The same
 * argument the tool-description check makes, and the reason AgentSummary holds lists - a list longer
 * than one *is* the finding, so nothing is counted twice to reach it.
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

  const drifted = stated.filter(
    (agent) =>
      agent.models.length > 1 ||
      agent.apis.length > 1 ||
      agent.endpoints.length > 1 ||
      agent.reasoningEfforts.length > 1,
  );
  if (drifted.length > 0) {
    const first = drifted[0]
    return {
      name,
      scope,
      outcome: "failed",
      detail:
        `${first?.name ?? "a seat"} ran ${formatCount(Math.max(first?.models.length ?? 0, first?.apis.length ?? 0, first?.endpoints.length ?? 0, first?.reasoningEfforts.length ?? 0))} ` +
        `different settings during the round, so its turns did not all answer under the same setup`,
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

/** parseGameRound reads one round's entries: its maze, and whether what the log carries about that
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
export function parseGameRound(entries: LogEntry[]): GameRound {
  let maze: MazeResult | null = null;

  // The first level-started maze, decoded with the round's own start and destination - the same two the
  // replay decodes with, so what comes back here is what the replay would build.
  //
  // Per entry, not once, because a group keyed game/level holds a replay of that level too and each
  // opening carries its own maze. The first is the one buildLevels reads, so it is the one returned.
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
 * Text in, because text is what arrives - a fetch body, a paste, a file. The parse and the envelope
 * contract were once two exported functions with a type between them that existed only to carry the
 * halfway point, and nothing ever called the second half alone.
 *
 * Returns a discriminated result rather than throwing, because every failure here is reported to a
 * person - the app renders it beside the input the reader typed - and none of them is exceptional.
 *
 * Strict on identity (name, entry shape) and deliberately lenient on version: refusing an unrecognized
 * build would make the analyzer useless against exactly the logs most worth inspecting, those from a
 * Tapoo newer than this app. An unknown version analyzes, with a warning attached.
 *
 * Its successful output is the normalized shape every downstream query uses: name, version, mode,
 * downloadedAt, readable entries, and the index built over them. What it does *not* do is read a round -
 * see parseGameRound. */
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

  // The same pass that validated the entries describes them: what the log contains, and where each
  // turn starts and ends. Every later reader indexes into this instead of walking the array again.
  const index = indexLog(entries);

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

  // Only the export's own caveats. A round's are parseGameRound's; unknownEvents and
  // levelDisagreements are deliberately not warnings at all - each says why.

  const log: TapooLog = {
    name: envelope.name,
    version: typeof envelope.version === "string" ? envelope.version : null,
    mode: typeof envelope.mode === "string" ? envelope.mode : null,
    downloadedAt: typeof envelope.downloadedAt === "string" ? envelope.downloadedAt : null,
    entries,
    index,
  };

  return {ok: true, source: sourceUrl ? {...log, sourceUrl} : log, warnings, checks};
}
