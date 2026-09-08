// The shapes the modules hand each other.
//
// These live in one file because they are contracts between modules, not implementation details of
// any one of them. Everything here is a type: nothing is emitted, so importing from here costs the
// browser bundle nothing.

// --- The log wire format ---

/** A cell's coordinates, validated - the shape to carry when row and column are what is actually
 * wanted.
 *
 * A CellKey is a Map key and nothing more. Reaching row and column back out of one means splitting a
 * string and coercing two numbers, at every place that needs them, with no type saying whether the
 * result is trustworthy. Anything that has coordinates to work with should hold this instead and let
 * getCellKey make the key at the moment a key is needed. */
export type Cell = {row: number; col: number};

/** A cell key, `"row,col"`. Cells travel as strings because they are Map and Set keys, and arrays
 * compare by identity. */
export type CellKey = string;

/** A cell as a log records it. Downloaded logs compact `{row, col}` to `[row, col]`, so both shapes
 * are real and a reader must handle either. Writing this as a union is what forces every call site to
 * say which one it means - the alternative produced `"undefined,undefined"` keys in silence.
 *
 * `cellFromLogged` narrows one of these to `Cell`; `getCellKey` accepts either and yields the key. */
export type LoggedCell = Cell | readonly [number, number];

/** The four commands Tapoo accepts. Anything else in a log is a move the maze cannot apply. */
export type Move = "MoveUp" | "MoveDown" | "MoveLeft" | "MoveRight";

/** Which moves lead *out* of each cell - the open exits, keyed by cell.
 *
 * Two things wear this type and the whole point is that they are comparable: the exits a decoded maze
 * *has*, and the exits a log's tool results say the agent was *shown*. Reading one against the other is
 * why the maze is drawn beside the profile at all, and while they were spelled out separately at each
 * declaration it was possible for one to drift - it did, as `Set<string>` against `Set<Move>`, and the
 * comment claiming they matched was wrong for as long as that lasted.
 *
 * "Open" is the load-bearing word. A move absent from a cell's set is a wall - the set is the complete
 * statement of where movement is possible from that cell, not a list of the ones anybody happened to
 * record - so an absence here is evidence, and reading it as "not known" would invert the meaning. */
export type OpenCellExits = Map<CellKey, Set<Move>>;

/** How heavily a cell has been worked, as Tapoo grades it.
 *
 * Tapoo's own rule, from get_maze_structure's description: it compares the cell's visit count with its
 * fixed open-exit count. `explored` is below, `backtracking` is equal - every exit used once, so the
 * direction is exhausted - and `oscillating` is above, which is moves being wasted. A dead-end reads as
 * `backtracking` from its first visit, because nothing lies beyond a single exit.
 *
 * Read from the log, never derived here. The count it is computed from is not serialized, so a status
 * we worked out ourselves could not be checked against the source - and if Tapoo's grading is ever
 * wrong, a report that recomputed it would hide the defect instead of showing it. */
export type VisitStatus = "unvisited" | "explored" | "backtracking" | "oscillating";

/** Per-turn payloads, stored so the turn offset cannot be applied twice or forgotten.
 *
 * Tapoo reports a turn's outcome on the request that *follows* it. That rule used to be a bare `- 1`
 * beside a plain Map, which meant every writer had to remember it and every reader had to trust that
 * they had - and one of them did not, so the maze overlay ran a turn behind. Here the two are one
 * thing: `record` is the only way in and takes the turn that *carried* the payload, `get` is the only
 * way out and takes the turn it *covers*. There is no key to get wrong.
 *
 * Key -1 is the state before the first turn - what the payload logged on turn 0 covers. */
export type TurnReports<T> = {
  /** Store what the request on `reportingTurn` carried, under the turn it covers. `merge` combines with
   * an existing entry when a turn carried more than one payload. */
  record: (reportingTurn: number, value: T, merge?: (existing: T, incoming: T) => T) => void;
  /** What is known about `turn` itself. */
  get: (turn: number) => T | undefined;
  /** Every entry, ascending by the turn it covers. */
  ascending: () => Array<[number, T]>;
  values: () => T[];
  readonly size: number;
};

/** Cell grades keyed by the turn they describe, not the turn that carried them. */
export type VisitStatusByTurn = TurnReports<Map<CellKey, VisitStatus>>;

/** The level Tapoo stamps on an entry, and it writes them with a meaning: `warn` is an agent error
 * carrying a penalty, `error` is a failure outside the agent's control that disabled it, and `info` is
 * everything else. */
export type LogLevel = "error" | "info" | "warn";

/** Who is answerable for an entry, as `levelClassOf` reads it off the level.
 *
 * The rubric already draws this line - endpoint failures are kept out of the violation profile because
 * they can come from infrastructure rather than reasoning - but it drew it by matching payload
 * sentences. The level says the same thing, declared by the producer. */
export type LogClass = "neutral" | "penalised" | "external";

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

/** Where one round-scoped turn begins and ends in the entries array, as a half-open range. */
export type TurnSpan = {
  game: number | null;
  level: number | null;
  turn: number;
  start: number;
  end: number;
};

/** The three fields that name a turn uniquely. Turn numbers restart every round, so a turn number
 * alone is ambiguous across a log holding more than one. */
export type TurnIdentity = Pick<TurnSpan, "game" | "level" | "turn">;

/** How the turn spans were arrived at.
 *
 * "field" means every entry carried a turn number. "unavailable" means at least one did not: logs
 * written before the turn counter landed infer their boundaries from predictions instead, which
 * buildContext still does for itself. The index says so rather than guessing, so a caller never reads
 * spans that were invented. */
export type TurnSource = "field" | "unavailable";

/** What a log contains, counted once on the way in. Descriptive only - nothing here is a verdict. */
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
  byTurn: Map<string, TurnSpan>;
};

/** A validated export: its envelope, its readable entries, and the index built over them. Reaching
 * this shape means the JSON parsed and at least one entry matched the entry contract. */
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

/** A validated URL, or the reason it was refused. */
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

/** A parsed export, with any caveats the parse raised.
 *
 * Warnings travel with a *success*: a log can be readable and still worth a caveat, and dropping them
 * on the way out is how a caveat goes unsaid.
 *
 * There was a second result type beside this one carrying the same pair, for the halfway point between
 * parsing the JSON and checking the envelope. Nothing outside that one function ever held the halfway
 * value, so the two steps - and the two types - are now one. */
export type LogTextResult = Result<{source: TapooLog; warnings: LogWarning[]}>;
/** A share-link payload, or why the token could not be read. */
export type PayloadResult = Result<{payload: string}>;

/** A rejected share link always carries the link it is about, so the view can mark it up.
 *
 * `link` is required on the failure arm deliberately. It used to be absent on one path - the last
 * line delegated to `validateOnlineJsonUrl`, whose failure has no `link` - and the caller read it
 * unconditionally, so the "(broken link: ...)" hint silently vanished for that one failure. Declaring
 * it required is what makes that path a compile error rather than an undefined. */
export type DecodedPayload = {ok: true; url: string} | {ok: false; error: string; link: string | null};

// --- Maze ---

/** A decoded maze: its dimensions and, per cell, the moves that lead out of it. */
export type Maze = {rows: number; cols: number; exits: OpenCellExits};

/** Structural counts over a decoded maze.
 *
 * `successPathCells` counts **cells** on the shortest start-to-destination route, start and destination
 * included - one more than the move count `successPathLength` returns, and the unit the report compares
 * against `cells`. Null when no route exists in the decoded structure, which is a finding, not a zero. */
export type MazeStats = {
  rows: number;
  cols: number;
  cells: number;
  deadEnds: number;
  corridors: number;
  junctions: number;
  deg3: number;
  deg4: number;
  edges: number;
  successPathCells: number | null;
};

/** The maze as the log carries it. `structure_checksum` is Tapoo's own hash of `structure`, and it is
 * the only way to tell a maze that arrived intact from one truncated in transit. */
export type EncodedMaze = {
  index_chars: string[];
  structure: string;
  structure_checksum: string;
  dimensions?: {numRows?: number; numCols?: number; area?: number};
};

/** A decoded maze with its grid and stats, or why decoding failed. */
export type MazeResult = Result<{maze: Maze; grid: string[][]; stats: MazeStats}>;

/** What reading one round's entries turns up: its maze, and the caveats about that round.
 *
 * Produced by parseGameRound. `maze` is the round's first level-started maze decoded against its own
 * start and destination - null when the round carried none - and `warnings` are the round's alone,
 * never the log's. */
export type GameRound = {maze: MazeResult | null; warnings: LogWarning[]};

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

/** One thing that happened, in log order: the agent stood somewhere, or it submitted moves. */
export type TimelineEvent =
  | {kind: "position"; cell: CellKey}
  | {kind: "submission"; record: Submission};

/** Everything one round's entries yielded, gathered in a single pass.
 *
 * The rubric groups read this and nothing else, so a question can only be answered from evidence the
 * pass actually collected - which is what keeps a verdict traceable to the log. Built per round: a
 * retry is a different maze, and positions or exits leaking across would describe neither. */
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
  /** The replay record each turn reported, keyed by the turn that *reported* it - which is the turn
   * after the one it describes. Kept apart from `replays` because that list is deduplicated by a
   * transition key, so two turns submitting the same move with the same outcome collapse into one
   * entry; a map keyed by reporting turn cannot lose a turn that way. */
  replayByTurn: TurnReports<Replay>;
  /** Running totals of what the model produced. Accumulated rather than kept per response: the report
   * describes a sample, and 719 individual token counts are not a summary of anything. */
  output: {
    responses: number;
    promptTokens: number | null;
    completionTokens: number | null;
    reasoningTokens: number | null;
    cachedPromptTokens: number | null;
    finishReasons: Map<string, number>;
  };
  exits: OpenCellExits;
  /** Visit statuses keyed by the turn whose end they report - never by the turn that carried them, which
   * is one later. Not cumulative: a cell appears only where a payload named it, and the view carries the
   * last one forward. Key -1 is the state the round opened in. */
  visitStatusAfterTurn: VisitStatusByTurn;
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

/** One turn's outcome, as get_last_prediction_outcome reported it to the turn after it.
 *
 * Logged verbatim - this tool carries no content_checksum, which is Tapoo's marker for a message whose
 * content was trimmed or compacted - so these are the values Tapoo actually sent, not a reconstruction.
 *
 * Every field is optional: it is read from arbitrary JSON, and two different producers push into the
 * same array. */
export type Replay = {
  lastMoveStatus?: string | null;
  lastSubmittedMoves?: unknown;
  lastAppliedMoveIndex?: number | null;
  chargedMovesCount?: number;
  /** Where replay began: where the player stood *before* those moves applied. Tapoo's own tool
   * description warns against substituting currentCell here, which is where replay ended - doing so
   * makes an applied move look like it never happened. */
  lastReplayStartCell?: unknown;
  predictionStatus?: string | null;
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
  /** Turns the round recorded. Used to check that a reading exists for every one of them before the
   * closing turn's charge is settled by subtraction. */
  turnCount?: number;
  lastActionResult?: Replay;
};

/** One turn of play: who acted, what they submitted, and what the maze did with it.
 *
 * `cells` starts at the cell the turn *began* on, so a turn that applied two moves holds three cells.
 * `applied` and `decayCharged` are null where the log did not say - not zero, which is a reading. */
export type Turn = {
  turn: number;
  playerName: string | null;
  before: CellKey | null;
  moves: unknown[];
  applied: number | null;
  cells: CellKey[];
  rejectedMove: string | null;
  /** Decay units this turn was charged, as Tapoo reported it. Null when no reading covers the turn and
   * it could not be resolved by subtraction - a cost we could not read, which is not a cost of zero. */
  decayCharged: number | null;
};

/** One played round, as the replay needs it: its maze, its path, and how it ended.
 *
 * Named for the level it played, but keyed by (game, level) - a retry is a different round with a
 * brand-new maze, and merging two would draw a path crossing walls that exist in neither. */
export type Level = {
  key: string;
  game: number | null;
  level: number | null;
  encodedMaze: EncodedMaze | null;
  startPosition: {x?: number; y?: number} | null;
  startCell: CellKey | null;
  /** Resolved to a cell key here, not carried in the logged shape. The view used to do this conversion
   * itself and handled only {row, col}, so a compacted [row, col] silently became
   * "undefined,undefined" - no destination drawn, and the shortest route reported as "no route found". */
  destinationCell: CellKey | null;
  historyWindowRadius: number | null;
  endCell: CellKey | null;
  observedExits: OpenCellExits;
  visitStatusAfterTurn: VisitStatusByTurn;
  positions: CellKey[];
  turns: Turn[];
  outcome: Outcome | null;
};

/** Which half of the rubric a group belongs to. The two are never combined into one score. */
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

/** One rubric group's verdict and the answers behind it. `met` is the verdict; `passed`/`total` are
 * kept because "2/3" and "0/3" are both a no, and the difference is evidence. */
export type GroupResult = {
  id: string;
  label: string;
  questions: Record<string, string>;
  answers: Record<string, boolean>;
  met: boolean;
  passed: number;
  total: number;
};

/** One round's complete profile: what produced it, what it demonstrated, and what it violated. */
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
 * Every field is nullable because the providers report different subsets: Ollama counts no reasoning or
 * cached-prompt tokens, OpenAI and Anthropic do. A null means "this provider did not say", which is a
 * different claim from zero and is displayed differently.
 *
 * Wall-clock duration is deliberately absent. Ollama reports `total_duration` per response, but the
 * figure is throttled per request and carries the test machine's network and load along with it, so it
 * is not the model's time and cannot compare one run against another. Reading it and captioning the
 * caveat would still put a number on the page that invites the comparison it cannot support. */
export type ResponseUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedPromptTokens: number | null;
  finishReason: string | null;
};

/** The model's own output across the sample: what it was fed, what it produced, and how it stopped. */
export type ModelOutput = {
  responses: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedPromptTokens: number | null;
  /** Finish reasons and their counts, in first-seen order. */
  finishReasons: Array<[string, number]>;
};

/** One round's entries and the identity naming its round tab - everything the tab strip needs, and
 * nothing that costs a rubric pass.
 *
 * This is what an Analysis carries, so opening a log of fourteen rounds does not answer fourteen
 * rubrics to show one. A slice becomes a RoundReport when somebody looks at it. */
export type RoundSlice = {
  /** `game/level`. Stable across renders, so it is what a round-tab selection stores. */
  key: string;
  game: number | null;
  level: number | null;
  /** "Game 2 · Level 1" - what the round tab says. */
  label: string;
  /** "gemma4.json - Game 2 · Level 1" - what the round's own report is named, so a warning or an error
   * raised while answering names the round *and* the file it came from. Kept apart from `label`
   * because the tab has the file above it already and repeating it there would not fit. */
  reportLabel: string;
  entries: LogEntry[];
};

/** A slice once it has been answered: the verdicts, the decoded maze, and the caveats about THIS
 * round. Resolved on demand and memoized - see roundReportFor. */
export type RoundReport = RoundSlice & {report: Report; round: GameRound};

/** What a whole log analyzed to: its rounds, and the caveats a reader is owed. */
export type Analysis = Result<{
  source: TapooLog;
  warnings: LogWarning[];
  /** The rounds this log recorded, in the order they were played. Never empty for a parsed log: a log
   * that names no round at all still yields one round holding everything. Unanswered: each is answered
   * when it is opened, because a verdict about one maze is not a verdict about the next one and a
   * reader is looking at one of them. */
  rounds: RoundSlice[];
}>;

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
  observedExits: OpenCellExits;
  visitStatusAfterTurn: VisitStatusByTurn;
  /** How far from its current cell the agent could see its own traversal history, as a Manhattan
   * radius in cells. It bounds what the agent knew when it chose each move, so it belongs beside the
   * round's other facts rather than with the maze's fixed shape. */
  historyWindowRadius: number | null;
  turns: Turn[];
  outcome: Outcome | null;
  agents: string[];
};

/** The replay at one scrubber position - everything the view draws for that turn.
 *
 * Derived per position rather than accumulated, so scrubbing backwards shows the same picture as
 * scrubbing forwards to the same place. */
export type Frame = {
  played: Turn[];
  turnIndex: number;
  totalTurns: number;
  /** Every cell entered so far, with the seat that last entered it and how Tapoo graded it as of this
   * frame. The status is the last one reported at or before this turn, so it changes as you scrub, and
   * null where the log never graded the cell - never a grade inferred here. */
  visited: Map<CellKey, {playerName: string | null; status: VisitStatus | null}>;
  positions: Map<string, CellKey>;
  currentCell: CellKey | null;
  rejected: {cell: CellKey | null; move: string} | null;
  turn: Turn | null;
};

// --- Log tabs ---

/** Where a tab stands: nothing loaded, a report ready, or a load that failed. */
export type LogTabStatus = "empty" | "loaded" | "error";
/** Where the URL being typed into the add-tab field stands. */
export type DraftStatus = "empty" | "loading" | "error";

/** One loaded log and its report. `loadedUrl` is what actually produced `result`, which is not always
 * `url` - the field can be edited after a load, and comparing the two is what tells the control the
 * displayed report is stale. */
export type LogTab = {
  id: string;
  url: string;
  label: string;
  status: LogTabStatus;
  loadedUrl?: string;
  result?: Analysis;
  error?: string;
};

/** The whole control's state, replaced wholesale on every change rather than mutated in place. */
export type LogTabsState = {
  tabs: LogTab[];
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
export type LogTabsInput = HTMLElement & {value: LogTabsState};

// --- The injected Observable globals ---

/** Only the surface this app actually uses.
 *
 * Neither `htl` nor `@observablehq/inputs` ships type definitions, and `htl` is deliberately a
 * devDependency - the page gets `html` from the Observable runtime, not from a bundled copy.
 * Declaring the two calls we make documents that coupling instead of pretending to type the
 * libraries. */
export type Html = (strings: TemplateStringsArray, ...values: unknown[]) => Element;

/** The one Inputs call this app makes. */
export type InputsApi = {
  table: (rows: unknown[], options?: Record<string, unknown>) => HTMLElement;
};

/** The two Observable globals, passed in rather than imported - see the note on `Html`. */
export type ReportUi = {html: Html; Inputs: InputsApi};

/** A rendered region: an element, or the empty string when a section renders nothing. */
export type Region = Element | "";
