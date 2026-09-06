// The maze replay's own model: one round turned into something drawable.
//
// Pure and document-free, which is why it is tested in node while the view beside it needs jsdom.

import { classifyTraversalSpeed } from "./log-contract"
import { mazeFromEncoded } from "./maze"
import { clamp, formatCount } from "./utils"
import type { CellKey, Frame, LevelModel, Report } from "./types"

// The maze replay owns its own data shaping. These were in oracle.js, under the rule that oracle
// holds adapters and view modules hold DOM - but nothing outside this file uses them, and the split
// meant reaching into a module about reports for two functions only the maze calls. Pure and
// document-free, so they stay testable without a DOM.


// mazeReplayModel turns each played round into everything the maze view needs, or the reason it cannot
// be drawn.
//
// The maze is not optional context: a traversal drawn on a grid that failed its checksum would be a
// picture of damaged bytes presented as evidence. So a round that cannot be decoded carries an error
// instead of a partial grid, and the view renders the error.
export function mazeReplayModel(report: Report): LevelModel[] {
  const levels = report?.levels ?? [];

  return levels.map((level) => {
    // The destination arrives already resolved to a cell key. It used to be converted here from
    // {row, col}, which silently produced "undefined,undefined" whenever a downloaded log had
    // compacted it to [row, col] - no destination drawn, and "no route found" reported as evidence.
    // One reader in the contract now handles both shapes for every field that carries a cell.
    const destination = level.destinationCell;
    const built = mazeFromEncoded(level.encodedMaze, {
      startCell: level.startCell,
      destinationCell: destination
    });

    // Colour is assigned per player in first-acting order, so a seat keeps the same colour across every
    // level of a log rather than changing when another seat happens to move first.
    const agents: string[] = [];
    for (const turn of level.turns) {
      if (turn.playerName && !agents.includes(turn.playerName)) agents.push(turn.playerName);
    }

    return {
      key: level.key,
      game: level.game,
      level: level.level,
      label: `Level ${level.level}${levels.length > 1 ? ` (game ${level.game})` : ""}`,
      maze: built.ok ? built.maze : null,
      error: built.ok ? null : built.error,
      stats: built.ok ? built.stats : null,
      startCell: level.startCell,
      destinationCell: destination,
      endCell: level.endCell,
      observedExits: level.observedExits,
      turns: level.turns,
      outcome: level.outcome,
      agents
    };
  });
}

// mazeFrameAt reports the state of the replay after `turnIndex` turns have been played.
//
// Pure, and the only thing the scrubber calls: keeping the frame a value rather than mutating the view
// means every position it can show is reachable in a test without a browser.
export function mazeFrameAt(levelModel: LevelModel, turnIndex: number): Frame {
  const played = levelModel.turns.slice(0, clamp(turnIndex, 0, levelModel.turns.length));
  const visited = new Map<CellKey, string | null>();

  if (levelModel.startCell) visited.set(levelModel.startCell, null);
  for (const turn of played) {
    for (const cell of turn.cells) visited.set(cell, turn.playerName);
  }

  const current = played.at(-1);
  const positions = new Map<string, CellKey>();
  for (const turn of played) {
        const last = turn.cells.at(-1);
    if (turn.playerName && last) positions.set(turn.playerName, last);
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

type SummaryRow = {field: string; value: string};

// DECAY_REASONS is Tapoo's charging rule, which is an ordinal scale of three and not a measurement.
// Every turn pays a base unit; an invalid move costs two; a response that broke the output format
// costs three. Lives here rather than in the view because two surfaces now read the same scale - the
// strip under the scrubber and the Turns row - and a reader comparing them must not find two
// vocabularies for one rule.
export const DECAY_REASONS: Record<number, string> = {
  1: "base charge",
  2: "invalid move",
  3: "output format violation",
};

// The most a turn can be charged: Tapoo's own ceiling.
//
// Three is charged only when lastSubmittedMoves is empty - a malformed response, an exhausted token
// cap, or a failed request.
export const MOST_DECAY = 3;

/** How a round's turns divide across the three charges, plus the turns no reading covered. */
export type DecayTally = {
  /** One entry per charge the round actually incurred, ascending. A charge that never happened is
   * absent rather than zero: naming a penalty nobody paid describes the rules, not the run. */
  counts: Array<{charge: number; count: number}>;
  /** Turns whose charge no reading settled. Not zero-cost turns - unmeasured ones. */
  unreported: number;
};

// decayTally counts turns by what they were charged. The single source both the legend under the
// scrubber and the Turns row count from, so the two can never disagree.
export function decayTally(levelModel: LevelModel | null | undefined): DecayTally {
  const counts = new Map<number, number>();
  let unreported = 0;

  for (const turn of levelModel?.turns ?? []) {
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

// mazeStructureRows describes the static shape of the maze — its topology and the two structural
// proofs that confirm it is a valid perfect maze. These facts do not change as the round is played.
export function mazeStructureRows(levelModel: LevelModel | null | undefined): SummaryRow[] {
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

// mazeLevelRows describes the round-level facts that belong to the level as a whole rather than to
// any one agent: how the level ended, how many turns it ran, and the length of the success route.
export function mazeLevelRows(levelModel: LevelModel | null | undefined): SummaryRow[] {
  if (!levelModel?.stats) return [];

  const stats = levelModel.stats;
  const outcome = levelModel.outcome ?? {};
  const pathCoverage = Math.round((stats.successPath! / stats.cells) * 100);

  // The turn count on its own says how many attempts there were and nothing about what they cost. The
  // breakdown says both, and it is the same partition the strip under the scrubber draws - so a reader
  // can add the bottom bars up and land on these numbers. The text here is the fallback; the view
  // renders the same tally with the strip's own colours.
  //
  // Joined with "+" rather than a middot: the parts are a partition of the total, and the sign says so.
  // A separator that only groups leaves the reader to guess whether these are shares of 473 or three
  // unrelated tallies printed beside it.
  const tally = decayTally(levelModel);
  const parts = tally.counts.map((entry) => formatCount(entry.count));
  if (tally.unreported > 0) parts.push(`${formatCount(tally.unreported)} unreported`);

  return [
    {field: "Outcome", value: outcome.outcome ?? "unfinished"},
    {
      field: "Turns",
      value:
        parts.length > 1 ? `${formatCount(levelModel.turns.length)} (${parts.join(" + ")})` : formatCount(levelModel.turns.length),
    },
    {field: "Success path", value: `${formatCount(stats.successPath!)} of ${formatCount(stats.cells)} (${pathCoverage}%)`},
  ];
}

// AgentLevelStats carries the per-agent metrics for a level. Each array is parallel to `agents`:
// index 0 is the value for agents[0], index 1 for agents[1], and so on.
export type AgentLevelStats = {
  agents: string[];
  traversalSpeeds: string[];
  decayCharged: string[];
  cellsEntered: string[];
};

// mazeLevelAgentStats derives the metrics that belong to each individual agent — traversal speed,
// decay units charged, and cells entered — from the level's turn log and outcome record.
//
// Traversal speed comes from the outcome and is attributed to the agent named in outcome.agent. In a
// single-agent level the outcome is always that agent's, even when the field is absent from older
// logs. Per-turn decay and cells entered are accumulated directly from the turn log.
export function mazeLevelAgentStats(levelModel: LevelModel | null | undefined): AgentLevelStats | null {
  if (!levelModel?.stats || levelModel.agents.length === 0) return null;

  const stats = levelModel.stats;
  const outcome = levelModel.outcome ?? {};

  // The agent the outcome record belongs to. In older logs the field may be absent; a single-agent
  // level still has exactly one owner, so we attribute the outcome to the only agent in that case.
  const outcomeAgent = outcome.agent?.playerName;

  // Unique cells entered per named agent, accumulated from their turns.
  const cellsByAgent = new Map<string, Set<CellKey>>();
  for (const turn of levelModel.turns) {
    if (!turn.playerName) continue;
    const existing = cellsByAgent.get(turn.playerName) ?? new Set<CellKey>();
    for (const cell of turn.cells) existing.add(cell);
    cellsByAgent.set(turn.playerName, existing);
  }

  // Decay units charged per named agent, summed from their turns.
  const decayByAgent = new Map<string, number>();
  for (const turn of levelModel.turns) {
    if (!turn.playerName || turn.decayCharged === null) continue;
    decayByAgent.set(turn.playerName, (decayByAgent.get(turn.playerName) ?? 0) + turn.decayCharged);
  }

  const traversalSpeeds: string[] = [];
  const decayCharged: string[] = [];
  const cellsEntered: string[] = [];

  for (const agent of levelModel.agents) {
    // Attribute the outcome to this agent if the record names them, or if this is the only agent
    // and the record does not name anyone (older log format).
    const ownsOutcome = outcomeAgent === agent || (!outcomeAgent && levelModel.agents.length === 1);
    const speed = ownsOutcome ? Number(outcome.traversalSpeed) : NaN;
    traversalSpeeds.push(
      Number.isFinite(speed) ? `${classifyTraversalSpeed(speed)} (${speed.toFixed(4)})` : "not recorded",
    );

    const decay = decayByAgent.get(agent);
    decayCharged.push(decay !== undefined ? formatCount(decay) : "not recorded");

    const cells = cellsByAgent.get(agent);
    cellsEntered.push(
      cells
        ? `${formatCount(cells.size)} of ${formatCount(stats.cells)} (${Math.round((cells.size / stats.cells) * 100)}%)`
        : "not recorded",
    );
  }

  return {agents: levelModel.agents, traversalSpeeds, decayCharged, cellsEntered};
}

