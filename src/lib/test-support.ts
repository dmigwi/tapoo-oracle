import {parseTapooLogText} from "./log-contract";
import {fnv1a64Checksum} from "./utils";
import {buildReportAnalysis, roundReportFor} from "./log-tabs";
import type {Analysis, Level, LogWarning, RegionView, Report} from "./types";

// Helpers shared by the suites.
//
// Not shipped: nothing in src/lib/app.ts reaches this, so it never enters the bundle.

/** The report for a single-round log's only round.
 *
 * Most fixtures are one round, and reaching through `rounds[0]` at every call site would bury what is
 * actually being asserted. No emptiness check: Analysis.rounds is a non-empty tuple, so the first round
 * is a round. */
export function firstRound(result: Analysis): Report {
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

/** A report carrying nothing but the rounds a maze test is about.
 *
 * The replay views take a whole `Report` because that is what the page hands them, but the maze
 * suites are about rounds. Stating the rest once here keeps each case to the round it exercises, and
 * keeps the two suites agreeing on what an otherwise-empty report looks like. */
export function reportWith(...levels: Level[]): Report {
  return {
    label: "fixture",
    agents: [],
    output: {responses: 0, promptTokens: null, completionTokens: null, reasoningTokens: null,
      cachedPromptTokens: null, finishReasons: []},
    predictions: 0,
    traversalSpeed: null,
    traversalSpeedClass: null,
    capabilities: [],
    violations: [],
    diagnostics: {endpointFailures: 0, emptyResponses: 0, unparseableResponses: 0, tokenExhaustions: 0},
    levels,
  };
}

/** The message text of each warning, for a test asserting on wording rather than on impact. */
export function messagesOf(warnings: LogWarning[]): string[] {
  return warnings.map((warning) => warning.message);
}

/** analyzeLogText slices a log given as raw text into rounds, skipping the download.
 *
 * A test fixture, and it lives here rather than in log-tabs.ts because nothing in the app calls it.
 * The app's own path is a URL: loadTapooLogFromUrl fetches and parses, then buildReportAnalysis slices.
 * A copy of that composition sat in log-tabs.ts describing itself as "the single entry point from
 * raw text to a rendered result", which no production caller had ever used.
 *
 * It composes the same two steps the loaders do, so a suite that exercises it exercises the real
 * pipeline - everything but the fetch, which is what a fixture on disk is standing in for.
 *
 * It answers no rubric: like the app, that waits for roundReportFor. A test wanting verdicts asks
 * firstRound below, which resolves one. */
export function analyzeLogText(
  text: unknown,
  {label = "online log", sourceUrl}: {label?: string; sourceUrl?: string} = {},
): Analysis {
  const result = parseTapooLogText(text, {sourceUrl});
  if (!result.ok) {
    return {ok: false, error: result.error};
  }

  return buildReportAnalysis(result, label);
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
 * agentSettingsCheck reports, or what the Agents cell does with a setting that moved. Everything but
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
  const entry = (payload: string, details: unknown, turn: number) => ({
    epochMs: (clock += 1200), time: "2026-09-09 10:00:00",
    turn, level: LEVEL, game: GAME, log: "info", payload, details,
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
      entry("Agent level won.", {
        outcome: "won", traversalSpeed: "1.0000",
        agent: {seatId: 1, playerName: "Katara", model: "moonshotai/Kimi-K3:together", enabled: true},
        playerPosition: {x: 1, y: 7}, playerUniqueCellsVisited: 4, decayUnitsCharged: 4,
      }, 5),
    ],
  };
}
