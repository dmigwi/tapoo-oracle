import {LOG_EVENTS, parseTapooLogText} from "./log-contract";
import {fnv1a64Checksum} from "./utils";
import {sliceLogIntoRounds} from "./rounds";
import {roundReportFor} from "./rubric-report";
import type {GroupResult, PlayedRound, LogEntry, LogLevel, SlicedLogResult, LogWarning, RegionView, Report} from "./types";

// Helpers shared by the suites.
//
// Not shipped: nothing in src/lib/app.ts reaches this, so it never enters the bundle.

/** The report for a single-round log's only round.
 *
 * Most fixtures are one round, and reaching through `rounds[0]` at every call site would bury what is
 * actually being asserted. No emptiness check: SlicedLog.rounds is a non-empty tuple, so the first round
 * is a round. */
export function firstRound(result: SlicedLogResult): Report {
  return roundReportFor(expectOk(result).rounds[0]).report;
}

/** Narrows a discriminated result to its success arm, failing the test if it is not one.
 *
 * The unions exist so production code cannot read a success field off a failure. A test asserting on
 * a known-good fixture is stating that it *is* a success, and this says so once - which is more
 * honest than a cast, because a fixture that stops decoding fails here with the reason attached
 * rather than at some later property access. */
export function expectOk<T extends {ok: boolean}>(result: T): Extract<T, {ok: true}> {
  if (!result.ok) {
    throw new Error(`expected a success, got: ${JSON.stringify(result)}`);
  }
  return result as Extract<T, {ok: true}>;
}

/** The failure arm, for the many tests that assert on a reason. */
export function expectErr<T extends {ok: boolean}>(result: T): Extract<T, {ok: false}> {
  if (result.ok) {
    throw new Error(`expected a failure, got: ${JSON.stringify(result)}`);
  }
  return result as Extract<T, {ok: false}>;
}

/** Asserts a value is present and returns it narrowed.
 *
 * Most uses are `querySelector`, which is `T | null` because a selector can miss. In a test the miss
 * *is* the failure, and saying so here names the selector in the message instead of letting a later
 * `.textContent` throw on null with no clue which node was absent. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}

/** `root.querySelector`, failing the test when the selector matches nothing. */
export function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  return must(root.querySelector<T>(selector), selector);
}

/** `root.querySelectorAll` as an array. Empty is a legitimate result, so this does not assert. */
export function queryAll<T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

/** The element at `index`, failing the test when the collection is shorter than that.
 *
 * `noUncheckedIndexedAccess` makes every index access `T | undefined`, which is right: in production
 * a short list is a case to handle. In a test, indexing past the end means the thing under test
 * produced the wrong number of items, and that is worth saying directly rather than as a cascade of
 * `possibly undefined` at each later property. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}, got ${items.length} in total`);
  }
  return item;
}

/** A rendered region as an element, failing the test when the section rendered nothing.
 *
 * `RegionView` is `Element | ""` because a section that has nothing to say renders nothing, and the page
 * interpolates the empty string rather than an empty node. A test reaching into a region has already
 * asserted it rendered; this states that once instead of at every property. */
export function rendered(region: RegionView): HTMLElement {
  if (region === "") {
    throw new Error("expected a rendered region, got the empty one");
  }
  return region as HTMLElement;
}

/** The message text of each warning, for a test asserting on wording rather than on impact. */
export function messagesOf(warnings: LogWarning[]): string[] {
  return warnings.map((warning) => warning.message);
}

/** sliceLogText slices a log given as raw text into rounds, skipping the download.
 *
 * It runs the same two steps the app's loader does - parseTapooLogText, then sliceLogIntoRounds - so a
 * test exercises the real pipeline minus the fetch. It lives here because only tests call it.
 *
 * It answers no rubric: like the app, that waits for roundReportFor. A test wanting verdicts asks
 * firstRound below, which resolves one. */
export function sliceLogText(
  text: unknown,
  {label = "online log", sourceUrl}: {label?: string; sourceUrl?: string} = {},
): SlicedLogResult {
  const result = parseTapooLogText(text, {sourceUrl});
  if (!result.ok) {
    return {ok: false, error: result.error};
  }

  return sliceLogIntoRounds(result, label);
}

// --- A log with two seats, one of which did not hold still ---

/** twoSeatDriftLog builds a log whose seat 1 changes model mid-round.
 *
 * Built here rather than kept as a .json file. The real capture in _snapshot_/ is a capture - bytes
 * Tapoo wrote, which is what makes it evidence - and a synthetic log saved beside it in the same shape
 * invites being read as one more - a mistake easily made and hard to see. So the difference is kept
 * structural: this one exists only while a test runs, and it is TypeScript, like every other fixture in
 * this suite.
 *
 * It exists because the real capture has one seat that never changed anything, so it cannot show what
 * agentSettingsCheck reports, or what the Agents cell does with a setting that moved. It also carries one
 * failed request and one harness fault, which the capture has none of, so the diagnostics table has
 * something other than zeroes to render. Everything but
 * seat 1's model is held still, so the change is the only finding.
 *
 * Checksums are computed with the app's own hash, so the prompt and tool-description checks verify. The
 * traversal payloads deliberately carry none: reproducing Tapoo's pre-compaction bytes here would be
 * re-implementing filteredTraversalHistoryRebuild in the fixture, and a check that passes because the
 * fixture agrees with a copy of the code proves nothing. It reports "not checked", which is the truth
 * about this log. */
export function twoSeatDriftLog(): Record<string, unknown> {
  const MAZE = {
    index_chars: ["|", "---", "-", "   ", " ", "\n"],
    structure_checksum: "0x74af82cb14470b9d",
    structure:
      "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
    dimensions: {numCols: 6, numRows: 4, area: 24},
  };
  const GAME = 4;
  const LEVEL = 12;
  let clock = 1788100000000;
  const entry = (payload: string, details: unknown, turn: number, log = "info") => ({
    epochMs: (clock += 1200), time: "2026-09-09 10:00:00",
    turn, level: LEVEL, game: GAME, log, payload, details,
  });

  // One persona for the round: nobody's speed class changed, so the system prompt does not either.
  const persona = "You are the agent for this level, and you start it primed for success: your traversal speed has not been measured yet.";
  const rules = 'Reply with a bare JSON object holding a single "moves" array. No prose, no fences.';
  const tools = [
    {name: "get_maze_structure", description: "Get current/destination cells and the nearby explored maze structure in one call."},
    {name: "get_prediction_rules", description: "Get the rules a prediction must satisfy."},
    {name: "get_last_prediction_outcome", description: "Get the outcome of the previous prediction."},
  ].map((tool) => ({...tool, description_checksum: fnv1a64Checksum(tool.description)}));

  type Seat = {seatId: number; player: string; model: string; api: string; endpoint: string; reasoning: string};
  const turnOf = (
    turn: number, seat: Seat, cell: {row: number; col: number}, open: string, moves: string[], replay: unknown,
  ) => [
    entry("Agent request.", {
      seatId: seat.seatId, playerName: seat.player, player: `${seat.player} the Trailblazer - 1.0000x`,
      model: seat.model, api: seat.api, endpoint: seat.endpoint, reasoning: seat.reasoning,
      tools,
      messages: [
        {role: "system", content: persona, content_checksum: fnv1a64Checksum(persona)},
        {role: "user", content: rules, content_checksum: fnv1a64Checksum(rules)},
        {role: "tool", content: JSON.stringify({
          level: LEVEL, currentCell: cell, destinationCell: {row: 0, col: 5}, historyWindowRadius: 2,
          filteredTraversalHistory: [
            {playerName: seat.player, cell, cellType: "corridor", openMoves: {[open]: {visitStatus: "unvisited"}}},
          ],
        })},
        ...(replay ? [{role: "tool", content: JSON.stringify(replay)}] : []),
      ],
    }, turn),
    // The echo, trimmed of the ":provider" suffix the request declared - as every provider answers.
    entry("Agent response.", {
      payload: {
        model: seat.model.split(":")[0], message: {content: JSON.stringify({moves})},
        eval_count: 40, prompt_eval_count: 900,
      },
    }, turn),
  ];

  const katara = {
    seatId: 1, player: "Katara", api: "openai",
    endpoint: "https://router.huggingface.co/v1/chat/completions", reasoning: "high",
  };
  const bumi: Seat = {
    seatId: 2, player: "Bumi", model: "gemma4:cloud", api: "ollama",
    endpoint: "http://localhost:11434/api/chat", reasoning: "max",
  };
  const replayOf = (moves: string[], start: number[], charged: number) => ({
    lastMoveStatus: "applied", lastSubmittedMoves: moves, lastAppliedMoveIndex: 0,
    lastReplayStartCell: start, chargedMovesCount: charged, decayUnitsCharged: charged,
    playerUniqueCellsVisited: 2, predictionStatus: "applied",
  });

  return {
    name: "tapoo",
    version: "2.5.1",
    mode: "agent-api",
    downloadedAt: "2026-09-09T10-05-00+02-00",
    entries: [
      entry("Agent level started.", {
        startPosition: {x: 1, y: 1}, finalPosition: {x: 1, y: 7},
        destinationCell: {row: 0, col: 5}, historyWindowRadius: 2, maze: MAZE,
      }, 0),
      ...turnOf(1, {...katara, model: "moonshotai/Kimi-K3:baseten"}, {row: 0, col: 0}, "MoveDown", ["MoveDown"], null),
      ...turnOf(2, bumi, {row: 1, col: 0}, "MoveDown", ["MoveDown"], replayOf(["MoveDown"], [0, 0], 1)),
      // The change, and the only one in this log: same seat, same player, a model served elsewhere.
      ...turnOf(3, {...katara, model: "moonshotai/Kimi-K3:together"}, {row: 2, col: 0}, "MoveRight", ["MoveRight"], replayOf(["MoveDown"], [1, 0], 1)),
      ...turnOf(4, bumi, {row: 2, col: 1}, "MoveRight", ["MoveRight"], replayOf(["MoveRight"], [2, 0], 1)),
      // Two failures that are nobody's reasoning, so the diagnostics table shows a figure rather than a
      // column of zeroes. Logged at "error", which is the class EVENT_CLASSES gives both.
      //
      // A request that never came back, retried on the next turn.
      entry("Request failed before a valid response.", {
        endpoint: katara.endpoint, error: "TypeError: Failed to fetch",
      }, 4, "error"),
      // And a tool of Tapoo's own that threw, which is the harness breaking rather than the model failing.
      entry("Tool request could not be serviced.", {
        endpoint: katara.endpoint, requestCount: 2, toolNames: ["get_maze_structure"],
      }, 4, "error"),
      entry("Agent level won.", {
        outcome: "won", traversalSpeed: "1.0000",
        agent: {seatId: 1, playerName: "Katara", model: "moonshotai/Kimi-K3:together", enabled: true},
        playerPosition: {x: 1, y: 7}, playerUniqueCellsVisited: 4, decayUnitsCharged: 4,
      }, 5),
    ],
  };
}

// --- Rubric-shaped log entries ---
//
// A log is a sequence of entries, and every rubric question is answered from what those entries do or
// do not contain. These builders keep a test to the entries it is actually about: anything a test does
// not add is absent from the log, which is the state the rubric answers NO for.
//
// Shared rather than copied per suite, so the engine, the report and the rounds all answer questions
// about the same shape of log.

let clock = 0;

/** One entry, stamped game 1 level 1 and clocked a second after the last. */
export function rubricEntry(
  payload: string,
  details?: unknown,
  {log = "info", turn = 0}: {log?: LogLevel; turn?: number} = {},
): LogEntry {
  clock += 1000;
  return {epochMs: clock, time: "2026-08-31T09-00-00+02-00", level: 1, game: 1, turn, log, payload, details};
}

/** A tool result as a request carries it: the payload, serialised, under the tool role. */
export const toolMessage = (payload: unknown) => ({role: "tool", content: JSON.stringify(payload)});

/** One turn: the request carrying whichever tool results it read, then the model's reply. */
export function rubricTurn(
  number: number,
  {tools = [], content, messages = []}: {tools?: string[]; content?: string; messages?: unknown[]} = {},
): LogEntry[] {
  return [
    rubricEntry(LOG_EVENTS.request, {tools: tools.map((name) => ({name})), messages}, {turn: number}),
    rubricEntry(LOG_EVENTS.response, {payload: {model: "test-model", message: {content}}}, {turn: number}),
  ];
}

/** The round a report answered, or a failure naming what was expected. */
export function levelOf(report: Report): PlayedRound {
  if (!report.playedRound) throw new Error("expected the report to answer a round");
  return report.playedRound;
}

/** One rubric group by id, from either half of the profile. */
export function groupOf(report: Report, id: string): GroupResult {
  const found = [...report.capabilities, ...report.violations].find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no such group: ${id}`);
  return found;
}
