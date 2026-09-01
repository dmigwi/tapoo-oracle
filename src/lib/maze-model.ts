// The maze replay's own model: one round turned into something drawable.
//
// Pure and document-free, which is why it is tested in node while the view beside it needs jsdom.

import { classifyTraversalSpeed } from "./log-contract"
import { mazeFromEncoded } from "./maze"
import { formatCount } from "./report-adapters"
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
  const played = levelModel.turns.slice(0, Math.max(0, Math.min(turnIndex, levelModel.turns.length)));
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

// mazeSummaryRows describes the maze itself and how much of it the round actually used.
export function mazeSummaryRows(levelModel: LevelModel | null | undefined): Array<{field: string; value: string}> {
  if (!levelModel?.stats) return [];

  const stats = levelModel.stats;
  const walked = new Set(levelModel.turns.flatMap((turn) => turn.cells));
  if (levelModel.startCell) walked.add(levelModel.startCell);
  const outcome = levelModel.outcome ?? {};
  const agentCells = Number(outcome.playerUniqueCellsVisited);
  const coverage = stats.cells > 0 ? Math.round((walked.size / stats.cells) * 100) : 0;

  return [
    {field: "Maze size", value: `${stats.rows} x ${stats.cols} (${formatCount(stats.cells)} cells)`},
    {field: "Dead ends", value: formatCount(stats.deadEnds)},
    {field: "Corridors", value: formatCount(stats.corridors)},
    {field: "Junctions", value: formatCount(stats.junctions)},
    {
      field: "Shortest route",
      value: stats.shortestPath === null ? "no route found" : `${formatCount(stats.shortestPath)} moves`
    },
    {field: "Cells entered", value: `${formatCount(walked.size)} of ${formatCount(stats.cells)} (${coverage}%)`},
    {
      // Tapoo credits the start cell to the "Self" pseudo-player, so an agent's own unique-cell count is
      // one below the cells its path covers. Reporting both stops that gap reading as an error.
      field: "Credited to agent",
      value: Number.isFinite(agentCells) ? formatCount(agentCells) : "not recorded"
    },
    {
      field: "Decay charged",
      value: Number.isFinite(Number(outcome.decayUnitsCharged))
        ? formatCount(Number(outcome.decayUnitsCharged))
        : "not recorded"
    }
  ];
}

// levelSummaryRows gives one row per played round, so a multi-level log reads as a sequence rather than
// a single aggregate.
export function levelSummaryRows(report: Report | null | undefined): Array<Record<string, string | number>> {
  return (report?.levels ?? []).map((level) => {
    const outcome = level.outcome ?? {};
    const speed = Number(outcome.traversalSpeed);

    return {
      level: level.level ?? "-",
      game: level.game ?? "-",
      outcome: outcome.outcome ?? "unfinished",
      turns: level.turns.length,
      // Classified here rather than read from the log: the log's own class field is lower-cased, and two
      // spellings of the same class in one report read as two different things.
      speed: Number.isFinite(speed) ? speed.toFixed(4) : "not recorded",
      class: Number.isFinite(speed) ? classifyTraversalSpeed(speed) : "not recorded"
    };
  });
}
