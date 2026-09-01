// The shapes the modules hand each other.
//
// These live in one file because they are contracts between modules, not implementation details of
// any one of them. Everything here is a type: nothing is emitted, so importing from here costs the
// browser bundle nothing.

// --- The log wire format ---

/** A cell as a log records it. Downloaded logs compact `{row, col}` to `[row, col]`, so both shapes
 * are real and a reader must handle either. Writing this as a union is what forces every call site to
 * say which one it means - the alternative produced `"undefined,undefined"` keys in silence. */
export type LoggedCell = {row: number; col: number} | [number, number];

/** A cell key, `"row,col"`. Cells travel as strings because they are Map and Set keys, and arrays
 * compare by identity. */
export type CellKey = string;

/** The four commands Tapoo accepts. Anything else in a log is a move the maze cannot apply. */
export type Move = "MoveUp" | "MoveDown" | "MoveLeft" | "MoveRight";

/** Open exits as a log records them: an object keyed by move, or `[move, visitStatus]` pairs once the
 * result has been compacted for the download. */

export type LogLevel = "error" | "info" | "warn";

/** One entry, carrying only the fields `isLogEntry` actually verifies. `turn`, `level` and `game`
 * are optional because logs written before those counters landed still analyze. `details` is
 * `unknown` on purpose: it is arbitrary JSON, and every read of it has to narrow first. */
export type LogEntry = {
  epochMs: number;
  log: LogLevel;
  payload: string;
  time?: string;
  turn?: number;
  level?: number;
  game?: number;
  details?: unknown;
};

export type TapooLog = {
  name: string;
  version: string | null;
  mode: string | null;
  downloadedAt: string | null;
  entries: LogEntry[];
  sourceUrl?: string;
};

// --- Results ---

/** A result that says why it failed rather than throwing. Every consumer reports the failure to a
 * person, so the reason travels with it; declaring these as unions is what stops a caller reading a
 * success field off a failure. */
export type Result<T, E = string> = ({ok: true} & T) | ({ok: false; error: E});

export type UrlResult = Result<{url: string}>;
export type LogParseResult = Result<{value: TapooLog; warnings: string[]}>;
export type LogTextResult = Result<{source: TapooLog; warnings: string[]}>;
export type PayloadResult = Result<{payload: string}>;

/** A rejected share link always carries the link it is about, so the view can mark it up.
 *
 * `link` is required on the failure arm deliberately. It used to be absent on one path - the last
 * line delegated to `validateOnlineJsonUrl`, whose failure has no `link` - and the caller read it
 * unconditionally, so the "(broken link: ...)" hint silently vanished for that one failure. Declaring
 * it required is what makes that path a compile error rather than an undefined. */
export type DecodedPayload = {ok: true; url: string} | {ok: false; error: string; link: string | null};

// --- Maze ---

export type Maze = {rows: number; cols: number; exits: Map<CellKey, Set<Move>>};

export type MazeStats = {
  rows: number;
  cols: number;
  cells: number;
  deadEnds: number;
  corridors: number;
  junctions: number;
  shortestPath: number | null;
};

export type EncodedMaze = {
  index_chars: string[];
  structure: string;
  structure_checksum: string;
  dimensions?: {numRows?: number; numCols?: number; area?: number};
};

export type MazeResult = Result<{maze: Maze; grid: string[][]; stats: MazeStats}>;

// --- Rubric engine ---

/** One prediction and what became of it.
 *
 * `moves` is `unknown[]` because it comes straight out of a model's JSON: the parser checks that a
 * `moves` key exists, not that it holds move commands, so every use has to narrow. `before` and
 * `applied` are filled by a second pass (`annotateApplied`), which is why they are nullable here
 * rather than required. */
export type Submission = {
  moves: unknown[];
  tier: 1 | 2 | 3;
  keys: string[];
  turn: number;
  before?: CellKey | null;
  applied?: number | null;
};

export type TimelineEvent =
  | {kind: "position"; cell: CellKey}
  | {kind: "submission"; record: Submission};

export type Context = {
  label: string;
  model: string | null;
  player: string | null;
  exits: Map<CellKey, Set<string>>;
  positions: CellKey[];
  timeline: TimelineEvent[];
  submissions: Submission[];
  replays: Replay[];
  declaredTools: Set<string>;
  toolCalls: Array<string | undefined>;
  turnTools: Map<number, Set<string>>;
  turnsWithPrediction: Set<number>;
  speedReadings: Array<[number, number]>;
  outcomes: Outcome[];
  duplicatesAfterWarning: number;
  hallucinated: number;
  emptyResponses: number;
  unparseableResponses: number;
  endpointFailures: number;
  tokenExhaustions: number;
};

/** A `get_last_prediction_outcome` payload, as logged. Every field is optional: it is read from
 * arbitrary JSON and two different producers push into the same array. */
export type Replay = {
  lastMoveStatus?: string | null;
  lastSubmittedMoves?: unknown;
  lastAppliedMoveIndex?: number | null;
  chargedMovesCount?: number;
};

/** A round-end entry's details. `traversalSpeed` is a string in every real log (`"1.0000"`), which is
 * why it is not `number` here - reading it numerically without coercion is how a report ends up
 * printing `NaN`. */
export type Outcome = {
  outcome?: string;
  traversalSpeed?: string | number;
  traversalSpeedClass?: string;
  agent?: {playerName?: string};
  playerPosition?: {x?: number; y?: number};
  playerUniqueCellsVisited?: number;
  decayUnitsCharged?: number;
  lastActionResult?: Replay;
};

export type Turn = {
  turn: number;
  playerName: string | null;
  before: CellKey | null;
  moves: unknown[];
  applied: number | null;
  cells: CellKey[];
  rejectedMove: string | null;
};

export type Level = {
  key: string;
  game: number | null;
  level: number | null;
  encodedMaze: EncodedMaze | null;
  startPosition: {x?: number; y?: number} | null;
  startCell: CellKey | null;
  // Resolved to a cell key here, not carried in the logged shape. The view used to do this conversion
  // itself and handled only {row, col}, so a compacted [row, col] silently became
  // "undefined,undefined" - no destination drawn, and the shortest route reported as "no route found".
  destinationCell: CellKey | null;
  historyWindowRadius: number | null;
  endCell: CellKey | null;
  observedExits: Map<CellKey, Set<string>>;
  positions: CellKey[];
  turns: Turn[];
  outcome: Outcome | null;
};

export type GroupKind = "capability" | "violation";

/** One rubric group: its identity, the questions it asks, and the function that answers them. Keeping
 * the questions beside their evaluator is what stops the report describing a different question than
 * the engine answered. */
export type RubricGroup = {
  id: string;
  label: string;
  questions: Record<string, string>;
  evaluate: (context: Context) => Record<string, boolean>;
};

export type GroupResult = {
  id: string;
  label: string;
  questions: Record<string, string>;
  answers: Record<string, boolean>;
  met: boolean;
  passed: number;
  total: number;
};

export type Report = {
  label: string;
  model: string | null;
  player: string | null;
  predictions: number;
  rounds: number;
  traversalSpeed: number | null;
  traversalSpeedClass: string | null;
  capabilities: GroupResult[];
  violations: GroupResult[];
  diagnostics: {
    endpointFailures: number;
    emptyResponses: number;
    unparseableResponses: number;
    tokenExhaustions: number;
  };
  levels: Level[];
};

export type Analysis = Result<{source: TapooLog; warnings: string[]; report: Report}>;

// --- Maze replay ---

/** The view's own model of a round. */
export type LevelModel = {
  key: string;
  game: number | null;
  level: number | null;
  label: string;
  maze: Maze | null;
  error: string | null;
  stats: MazeStats | null;
  startCell: CellKey | null;
  destinationCell: CellKey | null;
  endCell: CellKey | null;
  observedExits: Map<CellKey, Set<string>>;
  turns: Turn[];
  outcome: Outcome | null;
  agents: string[];
};

export type Frame = {
  played: Turn[];
  turnIndex: number;
  totalTurns: number;
  visited: Map<CellKey, string | null>;
  positions: Map<string, CellKey>;
  currentCell: CellKey | null;
  rejected: {cell: CellKey | null; move: string} | null;
  turn: Turn | null;
};

// --- Report tabs ---

export type TabStatus = "empty" | "loaded" | "error";
export type DraftStatus = "empty" | "loading" | "error";

export type ReportTab = {
  id: string;
  url: string;
  label: string;
  status: TabStatus;
  loadedUrl?: string;
  result?: Analysis;
  error?: string;
};

export type ReportTabsState = {
  tabs: ReportTab[];
  activeTabId: string | null;
  isAdding: boolean;
  draftUrl: string;
  draftStatus: DraftStatus;
  draftError?: string;
  pendingTabId?: string;
  sharedLinkLoading?: boolean;
  sharedLinkError?: string;
  sharedLinkBroken?: string | null;
};

/** The Observable "viewof" protocol: the element the page binds to carries the current value. */
export type ReportTabsInput = HTMLElement & {value: ReportTabsState};

// --- The injected Observable globals ---

/** Only the surface this app actually uses.
 *
 * Neither `htl` nor `@observablehq/inputs` ships type definitions, and `htl` is deliberately a
 * devDependency - the page gets `html` from the Observable runtime, not from a bundled copy.
 * Declaring the two calls we make documents that coupling instead of pretending to type the
 * libraries. */
export type Html = (strings: TemplateStringsArray, ...values: unknown[]) => Element;

export type InputsApi = {
  table: (rows: unknown[], options?: Record<string, unknown>) => HTMLElement;
};

export type ReportUi = {html: Html; Inputs: InputsApi};

/** A rendered region: an element, or the empty string when a section renders nothing. */
export type Region = Element | "";
