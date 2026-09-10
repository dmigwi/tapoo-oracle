// The maze replay's own model: one round turned into something drawable.
//
// The replay shapes its own data rather than drawing on report-adapters, which shapes the report's. The
// two answer to different readers - a grid and a scrubber against a table of verdicts - and the rule
// that adapters live in one module was costing a reach into a file about reports for functions only the
// maze calls.
//
// Pure and document-free, which is why it is tested in node while the view beside it needs jsdom.

import { mazeFromEncoded } from "./maze"
import { clamp, formatCount } from "./utils"
import type { AgentSummary, CellKey, Frame, PlayedRound, ReplayModel, SummaryRow, TurnSummary, VisitStatus } from "./types"

// --- Entry point: what maze-view calls ---

/** mazeReplayModel turns one round into everything the maze view needs, or the reason it cannot be
 * drawn. Null for a report that answered no round.
 *
 * Takes the round rather than the report holding it: the replay draws a maze, and a verdict is not one
 * of its inputs.
 *
 * The maze is not optional context: a traversal drawn on a grid that failed its checksum would be a
 * picture of damaged bytes presented as evidence. So a round that cannot be decoded carries an error
 * instead of a partial grid, and the view renders the error. */
export function mazeReplayModel(round: PlayedRound | null | undefined): ReplayModel | null {
  if (!round) return null;

  // The destination arrives already resolved to a cell key: one reader in the contract handles both
  // logged shapes, for every field carrying a cell. Converting here instead means handling {row, col}
  // and turning a compacted [row, col] into "undefined,undefined" - no destination drawn, and
  // "no route found" reported as evidence.
  const destination = round.destinationCell;
  const built = mazeFromEncoded(round.encodedMaze, {
    startCell: round.startCell,
    destinationCell: destination
  });

  return {
    identity: round.identity,
    maze: built.ok ? built.maze : null,
    error: built.ok ? null : built.error,
    stats: built.ok ? built.stats : null,
    startCell: round.startCell,
    destinationCell: destination,
    endCell: round.endCell,
    observedExits: round.observedExits,
    visitStatusAfterTurn: round.visitStatusAfterTurn,
    historyWindowRadius: round.historyWindowRadius,
    turns: round.turns,
    outcome: round.outcome,
    agents: round.agents
  };
}

/** agentIndexOf resolves a turn to the seat that played it, as an index into `agents`, or -1 for a turn
 * no seat claims.
 *
 * By the stated seat first and the name second, which is how agentsFromRound gathers these records -
 * resolving them differently here would colour a trail for a seat the table does not list. The name
 * still has to work on its own: a legacy log states no seat on any turn, and the one
 * seatId such a log carries reaches the record from the round-end entry, so the seat matches nothing and
 * the name is all there is.
 *
 * An index rather than a name, because a name is not an identity. Two seats that stated a number and no
 * player both answer to "", and keyed by that they would share one trail, one colour and one marker -
 * drawn as a single agent that walked both paths. */
export function agentIndexOf(
  agents: readonly AgentSummary[],
  turn: {seatId: number | null; playerName: string | null},
): number {
  if (turn.seatId !== null) {
    const stated = agents.findIndex((agent) => agent.seatId === turn.seatId);
    if (stated >= 0) return stated;
  }
  if (turn.playerName === null) return -1;
  return agents.findIndex((agent) => agent.name === turn.playerName);
}

/** mazeFrameAt reports the state of the replay after `turnIndex` turns have been played.
 *
 * Pure, and the only thing the scrubber calls: keeping the frame a value rather than mutating the view
 * means every position it can show is reachable in a test without a browser. */
export function mazeFrameAt(levelModel: ReplayModel, turnIndex: number): Frame {
  const played = levelModel.turns.slice(0, clamp(turnIndex, 0, levelModel.turns.length));

  // The status each cell last carried as of this frame.
  //
  // The map is keyed by the turn whose end a payload reports, so the bound is simply the last
  // turn played - and -1 when none has been, which is the state the round opened in. Reading it any
  // other way is what made the colours lag: bounded by the turn that *carried* the payload, every frame
  // showed the world one turn before the one it was drawing.
  //
  // Statuses are reported only for cells inside that turn's history window, and the three payloads are
  // model-triggered tool calls that a turn may not carry at all, so a cell keeps the last thing said
  // about it until something says otherwise. Last one wins.
  const statuses = new Map<CellKey, VisitStatus>();
  const upTo = played.at(-1)?.turn ?? -1;
  for (const [turn, reported] of levelModel.visitStatusAfterTurn.ascending()) {
    if (turn > upTo) break;
    for (const [cell, status] of reported) statuses.set(cell, status);
  }

  // The start square is occupied before a single move, so it is never "awaiting" anything - but at frame
  // 0 no payload has graded it yet. Tapoo's window at turn 0 holds only that square, and a cell is
  // graded by a *neighbour* pointing back at it, so the first grade arrives on turn 1 once the agent has
  // stepped off.
  //
  // Backfilling that first grade to the earlier frames is a read, not a guess, and only here. A cell's
  // grade is a function of how many times it has been entered, and the start square cannot be re-entered
  // without the agent first leaving and returning - which takes moves, which is what produces the very
  // payload being read. So the first grade any payload gives the start square is the grade it had from
  // the outset. That argument holds for no other cell, which is why this is not a general rule.
  const start = levelModel.startCell;
  if (start !== null) {
    const known = statuses.get(start);
    if (known === undefined || known === "unvisited") {
      for (const [, reported] of levelModel.visitStatusAfterTurn.ascending()) {
        const first = reported.get(start);
        if (first !== undefined && first !== "unvisited") {
          statuses.set(start, first);
          break;
        }
      }
    }
  }

  const visited = new Map<CellKey, {playerName: string | null; status: VisitStatus | null}>();
  const enter = (cell: CellKey, playerName: string | null): void => {
    // null means the log never graded this cell, and the view draws that as its own mark rather than
    // guessing. Answering "explored" would be a grade Tapoo never issued - the weakest rung of the scale
    // is still a rung, and inventing one is the thing this report must not do.
    //
    // Two ways a walked cell has no usable grade. No payload ever named it: get_maze_structure is a
    // tool the model chooses to call, so a cell can be walked in a turn that never asked. Or the newest
    // reading still says "unvisited", which our own walk contradicts - true when it was written, and
    // stale by the time the agent stepped in. Neither is a measurement.
    //
    // A cell that was never entered is not in this map at all: it has no rect, and shows the paper.
    const reported = statuses.get(cell);
    visited.set(cell, {playerName, status: reported === undefined || reported === "unvisited" ? null : reported});
  };

  if (levelModel.startCell) enter(levelModel.startCell, null);
  for (const turn of played) {
    for (const cell of turn.cells) enter(cell, turn.playerName);
  }

  const current = played.at(-1);
  const positions = new Map<number, CellKey>();
  for (const turn of played) {
    const last = turn.cells.at(-1);
    const seat = agentIndexOf(levelModel.agents, turn);
    if (seat >= 0 && last) positions.set(seat, last);
  }

  return {
    // The turns this frame covers. Returned rather than recomputed by the caller: drawFrame needed the
    // whole level model purely to slice this same range again.
    played,
    turnIndex: played.length,
    totalTurns: levelModel.turns.length,
    visited,
    positions,
    currentCell: current?.cells.at(-1) ?? levelModel.startCell ?? null,
    // The wall the agent walked into on this turn, if any. Drawn only for the current turn: a rejected
    // move is an event, not a lasting property of the cell.
    rejected: current?.rejectedMove
      ? {cell: current.cells.at(-1) ?? null, move: current.rejectedMove}
      : null,
    turn: current ?? null
  };
}

/** DECAY_REASONS is Tapoo's charging rule, which is an ordinal scale of three and not a measurement.
 * Every turn pays a base unit; an invalid move costs two; a response that broke the output format
 * costs three. Lives here rather than in the view because two surfaces now read the same scale - the
 * strip under the scrubber and the Turns row - and a reader comparing them must not find two
 * vocabularies for one rule. */
export const DECAY_REASONS: Record<number, string> = {
  1: "base charge",
  2: "invalid move",
  3: "output format violation",
};

/** The most a turn can be charged: Tapoo's own ceiling.
 *
 * Three is charged only when lastSubmittedMoves is empty - a malformed response, an exhausted token
 * cap, or a failed request. */
export const MOST_DECAY = 3;

/** How a round's turns divide across the three charges, plus the turns no reading covered. */
export type DecayTally = {
  /** One entry per charge the round actually incurred, ascending. A charge that never happened is
   * absent rather than zero: naming a penalty nobody paid describes the rules, not the run. */
  counts: Array<{charge: number; count: number}>;
  /** Turns whose charge no reading settled. Not zero-cost turns - unmeasured ones. */
  unreported: number;
};

/** decayTally counts turns by what they were charged.
 *
 * Takes the turns rather than the level, because the two callers mean different sets of them: the Turns
 * row in the level summary counts the whole round, and the legend under the scrubber counts only what
 * has been played. One function, so the two can never disagree about how a charge is classified - only
 * about which turns they are asking about. */
export function decayTally(turns: readonly TurnSummary[]): DecayTally {
  const counts = new Map<number, number>();
  let unreported = 0;

  for (const turn of turns) {
    if (turn.decayCharged === null) {
      unreported += 1;
      continue;
    }
    const charge = Math.min(turn.decayCharged, MOST_DECAY);
    counts.set(charge, (counts.get(charge) ?? 0) + 1);
  }

  return {
    counts: [...counts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([charge, count]) => ({charge, count})),
    unreported,
  };
}

/** mazeStructureRows describes the static shape of the maze — its topology and the two structural
 * proofs that confirm it is a valid perfect maze. These facts do not change as the round is played. */
export function mazeStructureRows(levelModel: ReplayModel | null | undefined): SummaryRow[] {
  if (!levelModel?.stats) return [];

  const stats = levelModel.stats;

  return [
    {field: "Maze size", value: `${stats.rows} x ${stats.cols} (${formatCount(stats.cells)} cells)`},
    {field: "Dead ends", value: formatCount(stats.deadEnds)},
    {field: "Edges", value: formatCount(stats.edges)},
    {field: "Corridors", value: formatCount(stats.corridors)},
    {field: "3-exit junctions (deg3)", value: formatCount(stats.deg3)},
    {field: "4-exit junctions (deg4)", value: formatCount(stats.deg4)},
    {field: "Acyclic graph proof", value: `Edges = Maze_size - 1 = ${formatCount(stats.cells - 1)}`},
    {field: "Handshaking lemma proof", value: `Dead ends = deg3 + 2·deg4 + 2 = ${formatCount(stats.deg3 + 2 * stats.deg4 + 2)}`},
  ];
}

/** mazeLevelRows describes the round-level facts that belong to the level as a whole rather than to
 * any one agent: how it ended, how many turns it ran and what each was charged, the length of the
 * success route, and how far the agent could see its own history. */
export function mazeLevelRows(levelModel: ReplayModel | null | undefined): SummaryRow[] {
  if (!levelModel?.stats) return [];

  const stats = levelModel.stats;
  const outcome = levelModel.outcome ?? {};
  const pathCoverage = Math.round((stats.successPathCells! / stats.cells) * 100);

  // The turn count on its own says how many attempts there were and nothing about what they cost. The
  // breakdown says both, and it is the same partition the strip under the scrubber draws - so a reader
  // can add the bottom bars up and land on these numbers. The text here is the fallback; the view
  // renders the same tally with the strip's own colours.
  //
  // Joined with "+" rather than a middot: the parts are a partition of the total, and the sign says so.
  // A separator that only groups leaves the reader to guess whether these are shares of 473 or three
  // unrelated tallies printed beside it.
  const tally = decayTally(levelModel.turns);
  const parts = tally.counts.map((entry) => formatCount(entry.count));
  if (tally.unreported > 0) parts.push(`${formatCount(tally.unreported)} unreported`);

  return [
    {field: "Outcome", value: outcome.outcome ?? "unfinished"},
    {
      field: "Turns",
      value:
        parts.length > 1 ? `${formatCount(levelModel.turns.length)} (${parts.join(" + ")})` : formatCount(levelModel.turns.length),
    },
    {field: "Success path", value: `${formatCount(stats.successPathCells!)} of ${formatCount(stats.cells)} (${pathCoverage}%)`},
    // How much of its own history the agent could see, which bounds what any verdict about its choices
    // can fairly claim: a move that looks careless at radius 2 may have been the best available to
    // something that could not see the cell it had already exhausted.
    {
      field: "History window",
      value:
        levelModel.historyWindowRadius === null
          ? "not recorded"
          : `${formatCount(levelModel.historyWindowRadius)} cells (Manhattan radius)`,
    },
  ];
}
