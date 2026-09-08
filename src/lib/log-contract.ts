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
  LogWarning,
  MazeResult,
  AssistantMessage,
  ResponseUsage,
  LogEntry,
  LogTextResult,
  TapooLog,
} from "./types";

import {asArray, asRecord, asTrimmedText, fnv1a64Checksum, isRecord} from "./utils";
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

/** responseUsage reads what the provider reported about its own work, from either API shape.
 *
 * The two report overlapping but different things, so every field is nullable and a null means "this
 * provider did not say" rather than zero. Ollama counts tokens at the payload root; OpenAI nests them
 * under `usage` and adds the two that matter most for a reasoning model - how many of the completion
 * tokens were spent thinking, and how much of the prompt was served from cache rather than re-read. */
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

// isLogEntry reports whether one array element carries the fields every consumer relies on. turn,
// level, and game are checked but not required to be present: logs written before those counters
// landed still analyze correctly, and buildContext has an explicit fallback for a missing turn.
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


// unreadableResponseWarnings reports responses whose body this contract could not read at all.
//
// This is the check that was missing when it was needed most. A log of 1,459 entries analyzed to zero
// predictions and zero turns because every response was written in a provider shape the contract did
// not know, and nothing said so: each one was counted as an "empty response", which is a thing that
// legitimately happens, and 719 of them in a row looked no different from 719 quiet failures.
//
// The signal is precise rather than heuristic. Across every real log to hand - Ollama and OpenAI,
// 1,744 responses - not one has an unreadable *shape*; the 49 blank ones all have a readable message
// holding no text, which is a model stopping early and not a contract gap. So a single unreadable body
// means a shape this file does not handle, and that is worth saying on the first occurrence.
//
// Inaccurate, not incomplete: the rubric answers NO on absent evidence, so a prediction that was made
// but could not be read turns a YES into a NO. The verdicts are wrong, not merely fewer.
function unreadableResponseWarnings(entries: LogEntry[]): LogWarning[] {
  const responses = entries.filter((entry) => entry.payload === LOG_EVENTS.response);
  const unreadable = responses.filter((entry) => {
    const details = entry.details;
    const payload = details !== null && typeof details === "object" && "payload" in details
      ? details.payload
      : null;
    return assistantMessage(payload) === null;
  }).length;

  if (unreadable === 0) {
    return [];
  }

  const all = unreadable === responses.length;
  return [{
    impact: "inaccurate",
    message:
      `${unreadable} of ${responses.length} model ${responses.length === 1 ? "response" : "responses"} ` +
      `could not be read: the body is not in a shape this analyzer recognises. ` +
      `${all ? "No prediction in this log was scored" : "Those turns were not scored"}, so a capability ` +
      "answered NO may only mean the evidence for it was unreadable.",
  }];
}

// traversalPayloadWarnings verifies that every get_maze_structure result arrived intact.
//
// The visit-status overlay on the replay is read straight out of these payloads, so a damaged one would
// be drawn as fact. `content_checksum` is fnv1a64Checksum of the content Tapoo actually sent - not of
// the compacted form the log keeps - so it cannot be checked against what is on disk directly. It can be
// checked by rebuilding the original, which every field needed for is either in the record or on the
// round's "Agent level started." entry.
//
// Verified byte-exact against a real export: the key order, the compact separators, and cellType's
// precedence are all as Tapoo writes them, and 8 of 8 checksummed results in the snapshot log reproduce.
//
// Given one round's entries, by parseGameRound. It still runs a cursor rather than assuming a single
// maze: a group keyed game/level holds a replay of that level too, and each opening resets the facts the
// reconstruction needs. The cursor also predates the split - it used to walk the whole log - which is
// why the per-round call needs no other change.
//
// Checked when the round is opened rather than when its maze is drawn: a damaged payload is reported
// once, above the report, instead of being discovered by whoever happens to scrub to the turn holding
// it.
function traversalPayloadWarnings(entries: LogEntry[]): LogWarning[] {
  const warnings: LogWarning[] = [];

  let exits: OpenCellExits | null = null;
  let startCell: CellKey | null = null;
  let destinationCell: unknown = null;
  let historyWindowRadius: unknown = null;
  let damaged = 0;
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
        continue;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(message.content);
      } catch {
        continue;
      }
      const body = asRecord(payload);
      if (!Array.isArray(body.filteredTraversalHistory)) continue;

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

      if (fnv1a64Checksum(rebuilt) !== checksum) {
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

  return warnings;
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
 * here that assumes four is then describing something else. The snapshot log carries three - Default,
 * Navigator, Backtracker - never having reached Trailblazer mid-round. */
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
// speed class changes, so a real 16-turn round carries three - Trailblazer, Navigator, then
// Backtracker. Requiring one prompt per round would put an accuracy warning on every clean log.
//
// Tool *results* are excluded here for the same reason they are hashed elsewhere: their content is
// compacted rather than truncated, so it neither hashes nor ends in an ellipsis, and mistaking that for
// damage would warn on every log ever written.
function promptWarnings(entries: LogEntry[], round: string): LogWarning[] {
  const warnings: LogWarning[] = [];
  const toolSums = new Map<string, Set<string>>();
  const byChecksum = new Map<string, string[]>();
  const personas = new Set<string>();
  let damaged = 0;

  const note = (checksum: unknown, text: unknown): void => {
    if (typeof checksum !== "string" || typeof text !== "string") return;
    byChecksum.set(checksum, [...(byChecksum.get(checksum) ?? []), text]);
    // Trimmed text cannot be hashed, and a full text that happens to end in an ellipsis is only skipped
    // - the heuristic errs towards checking less, never towards warning wrongly.
    if (text.endsWith(COMPACT_TAIL)) return;
    if (fnv1a64Checksum(text) !== checksum) damaged += 1;
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

  for (const [checksum, texts] of byChecksum) {
    const full = texts.reduce((longest, text) => (text.length > longest.length ? text : longest), "");
    if (texts.every((text) => text === full || text === compacted(full))) continue;
    warnings.push({
      impact: "inaccurate",
      message:
        `${round} logs two different prompts or tool descriptions under one checksum (${checksum}), ` +
        "so what the agent was shown cannot be recovered from this log.",
    });
  }

  return warnings;
}

/** parseGameRound reads one round's entries: its maze, and whether what the log carries about that
 * round arrived intact.
 *
 * The round half of the contract. parseTapooLog answers for the file - is this a Tapoo export, are the
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
 * A maze that is absent or will not decode is *returned*, not warned about. It used to raise a warning
 * too, and that put the same finding in two places: the replay already says so where the reader is
 * looking at the empty space the traversal should occupy, and says it far better - what is missing,
 * what it costs, and that the rubric verdicts still stand. Two notices for one fault made the round
 * look twice as broken and gave the reader nothing the second one did not already have.
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

  const warnings: LogWarning[] = [];
  warnings.push(...promptWarnings(entries, roundName(entries)));
  warnings.push(...traversalPayloadWarnings(entries));
  return {maze, warnings};
}

/** parseTapooLogText is the ingress point: every log the app reads enters here, and nothing else in
 * this module takes a log from outside.
 *
 * Text in, because text is what arrives - a fetch body, a paste, a file. The JSON parse and the
 * envelope contract used to be two exported functions with a LogParseResult passed between them, and
 * nothing ever called the second half on its own: it was one operation split across a type that existed
 * only to carry the halfway point.
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

  warnings.push(...unreadableResponseWarnings(entries));

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

  return {ok: true, source: sourceUrl ? {...log, sourceUrl} : log, warnings};
}
