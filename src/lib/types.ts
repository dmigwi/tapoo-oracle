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

// --- Log index ---

/** What a log level says about who is answerable for an entry.
 *
 * Tapoo writes the level with that meaning: `warn` is an agent error that carries a penalty, `error`
 * is a failure outside the agent's control that disabled it, and `info` is everything else. The rubric
 * already draws this line - endpoint failures are kept out of the violation profile because they can
 * come from infrastructure rather than reasoning - but it drew it by matching payload sentences. The
 * level says the same thing, declared by the producer. */
export type LogClass = "neutral" | "penalised" | "external";

/** Where one turn begins and ends in the entries array, as a half-open range. */
export type TurnSpan = {turn: number; start: number; end: number};

/** How the turn spans were arrived at.
 *
 * "field" means every entry carried a turn number. "unavailable" means at least one did not: logs
 * written before the turn counter landed infer their boundaries from predictions instead, which
 * buildContext still does for itself. The index says so rather than guessing, so a caller never reads
 * spans that were invented. */
export type TurnSource = "field" | "unavailable";

export type LogSummary = {
  entries: number;
  turns: number;
  levels: Record<LogLevel, number>;
  /** Count per payload sentence, in the order first seen. */
  events: Map<string, number>;
  penalised: number;
  external: number;
  firstEpochMs: number | null;
  lastEpochMs: number | null;
};

/** What the initial scan of a downloaded log produces, beside the entries themselves. */
export type LogIndex = {
  summary: LogSummary;
  turnSource: TurnSource;
  /** Ordered by first appearance. Empty when turnSource is "unavailable". */
  turns: TurnSpan[];
  byTurn: Map<number, TurnSpan>;
};

export type TapooLog = {
  name: string;
  version: string | null;
  mode: string | null;
  downloadedAt: string | null;
  entries: LogEntry[];
  /** Built by the same pass that validates the entries - see indexLog. */
  index: LogIndex;
  sourceUrl?: string;
};

// --- Results ---

/** A result that says why it failed rather than throwing. Every consumer reports the failure to a
 * person, so the reason travels with it; declaring these as unions is what stops a caller reading a
 * success field off a failure. */
export type Result<T, E = string> = ({ok: true} & T) | ({ok: false; error: E});

export type UrlResult = Result<{url: string}>;
/** How a warning bears on the report the reader is about to read.
 *
 * Only two, because only two justify interrupting someone. "inaccurate" means a verdict in the report
 * may be wrong. "incomplete" means the report is missing something it is expected to carry, while what
 * it does say is still sound.
 *
 * A finding that is neither is not a warning. An event the rubric has no question for, or a log level
 * contradicting its own payload, describes work left to do in this codebase - real, worth fixing, and
 * nothing a reader can act on. Those live on the log index instead, where whoever fixes them will look.
 */
export type WarningImpact = "inaccurate" | "incomplete";

/** A caveat the reader is shown, carrying what it costs them. */
export type LogWarning = {impact: WarningImpact; message: string};

export type LogParseResult = Result<{value: TapooLog; warnings: LogWarning[]}>;
export type LogTextResult = Result<{source: TapooLog; warnings: LogWarning[]}>;
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
  /** Distinct API providers the requests went to, in first-seen order. Sets rather than single values
   * because a log is a sequence of requests and nothing stops two of them naming different providers -
   * reporting only the last would quietly hide that. */
  apis: Set<string>;
  /** Distinct reasoning-effort settings the requests carried, in first-seen order. */
  reasoningEfforts: Set<string>;
  /** Running totals of what the model produced. Accumulated rather than kept per response: the report
   * describes a sample, and 719 individual token counts are not a summary of anything. */
  output: {
    responses: number;
    promptTokens: number | null;
    completionTokens: number | null;
    reasoningTokens: number | null;
    cachedPromptTokens: number | null;
    durationNs: number | null;
    finishReasons: Map<string, number>;
  };
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
  /** The API providers the sample was produced against, and the reasoning effort asked of the model.
   * Both belong to provenance: the same model answers differently through a different provider or at a
   * different effort, so a verdict is only comparable to another taken under the same two. */
  apis: string[];
  reasoningEfforts: string[];
  output: ModelOutput;
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

/** One model response, normalized across the three provider wire shapes.
 *
 * The oracle reads logs from all three, and they agree on nothing structurally: Ollama puts the
 * message at `message`, OpenAI at `choices[0].message`, and Anthropic has neither - its content is a
 * top-level array of typed blocks, with tool calls as `tool_use` entries rather than a `tool_calls`
 * list. Normalizing here is what keeps that from being three shapes every reader has to know. */
export type AssistantMessage = {
  /** Concatenated text. Anthropic can spread one reply across several text blocks. */
  content: string | null;
  /** Tool names requested, in order. */
  toolNames: string[];
  /** The model's own thinking, where the provider reports it: Ollama's `thinking`, OpenAI's
   * `reasoning_content`, Anthropic's `thinking` blocks. */
  reasoning: string | null;
};

/** What a provider reported about one response, normalized across API shapes.
 *
 * Every field is nullable because the two providers report different subsets: Ollama gives a duration
 * and no reasoning-token count, OpenAI the reverse. A null means "this provider did not say", which is
 * a different claim from zero and is displayed differently. */
export type ResponseUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedPromptTokens: number | null;
  durationNs: number | null;
  finishReason: string | null;
};

/** The model's own output across the sample: what it was fed, what it produced, and how it stopped. */
export type ModelOutput = {
  responses: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedPromptTokens: number | null;
  durationNs: number | null;
  /** Finish reasons and their counts, in first-seen order. */
  finishReasons: Array<[string, number]>;
};

export type Analysis = Result<{source: TapooLog; warnings: LogWarning[]; report: Report}>;

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
