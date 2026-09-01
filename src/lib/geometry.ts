// Maze geometry and traversal speed: the pure arithmetic of Tapoo's grid.
//
// Its own module so maze.ts can use it without importing the log contract. The contract needs to
// validate an encoded maze - which means decoding one - and maze.ts needed cellKey and stepFrom from
// the contract, so leaving these there made the two files import each other.
//
// Nothing here reads a log or answers a question. It converts between the shapes a cell arrives in and
// the key the rest of the app uses, and it steps one cell to the next.

import type {CellKey, Move} from "./types";

// --- Maze geometry ---

// MOVES maps each accepted move command to its [row, col] delta. The four keys are also the complete
// set of valid commands, which is what C1.Q3 checks against.
export const MOVES: Record<Move, readonly [number, number]> = {
  MoveUp: [-1, 0],
  MoveDown: [1, 0],
  MoveLeft: [0, -1],
  MoveRight: [0, 1],
};

// isMove narrows a string out of a log to a command the maze can actually apply.
//
// This guard is why stepFrom can take a Move rather than a string. A log's openMoves field is prose
// from a model's turn, so it can name anything; before, the one caller that did not check
// (availableContextDisregard) reached MOVES[move] with an unrecognized name, destructured undefined,
// and threw out of the whole report.
export const isMove = (value: unknown): value is Move =>
  typeof value === "string" && Object.hasOwn(MOVES, value);

// Cells are Map/Set keys, so they travel as "row,col" strings rather than arrays, which compare by
// identity and would make every lookup miss.
export const cellKey = (row: number, col: number): CellKey => `${row},${col}`;

// cellFromLogged reads either shape a logged cell arrives in.
//
// A downloaded log compacts every get_maze_structure result before writing it, turning {row, col}
// into [row, col]. Both shapes are real, so this is the one place that decides which is which -
// every field carrying a logged cell goes through here. Handling it per-caller is what previously
// produced "undefined,undefined" keys: one reader was taught the compact form and another, reading a
// different field, was not.
// The parameter is `unknown`, not LoggedCell: every caller reads this straight out of parsed JSON,
// where the value is whatever the producer wrote. Taking the narrow type would only move the cast to
// each call site - and a cast at a call site is a claim about untrusted data that nothing checked.
export function cellFromLogged(cell: unknown): CellKey | null {
  if (Array.isArray(cell)) {
    const [row, col] = cell as unknown[];
    return typeof row === "number" && typeof col === "number" ? cellKey(row, col) : null;
  }

  if (cell !== null && typeof cell === "object" && "row" in cell && "col" in cell) {
    const {row, col} = cell;
    return typeof row === "number" && typeof col === "number" ? cellKey(row, col) : null;
  }

  return null;
}

// movesFromLogged returns the move names a cell's exits allow, from either logged shape: the
// uncompacted object keyed by move name, or the compacted [move, visitStatus] pairs. Reading the
// compacted form with Object.keys yields array indices - "0", "1" - which match no move command, so
// every exit check silently failed.
// `unknown` for the same reason as cellFromLogged: the value comes straight from a parsed log.
export function movesFromLogged(openMoves: unknown): Set<string> {
  if (Array.isArray(openMoves)) {
    return new Set(
      (openMoves as unknown[])
        .map((entry) => (Array.isArray(entry) ? (entry as unknown[])[0] : entry))
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );
  }

  return new Set(Object.keys(openMoves ?? {}));
}

// stepFrom resolves the cell reached by applying one move command to a "row,col" key.
export function stepFrom(key: CellKey, move: Move): CellKey {
  const [row, col] = key.split(",").map(Number);
  const [rowDelta, colDelta] = MOVES[move];
  // A key that does not parse is a programming error, not log data: every key this receives was
  // built by cellKey.
  if (row === undefined || col === undefined || Number.isNaN(row) || Number.isNaN(col)) {
    throw new Error(`not a cell key: ${key}`);
  }

  return cellKey(row + rowDelta, col + colDelta);
}

// --- Traversal speed ---

// The thresholds from the rubric's Agent-Scoped Traversal Speed section. Reached through
// classifyTraversalSpeed rather than exported: the classification is the contract, not the table.
const TRAVERSAL_SPEED_CLASSES = {
  backtracker: "Backtracker",
  navigator: "Navigator",
  trailblazer: "Trailblazer",
} as const;

// classifyTraversalSpeed applies the rubric's three-way split. A non-positive or non-finite speed
// resolves to Backtracker rather than defaulting upward - the rubric is explicit that a missing
// denominator must never produce a Trailblazer result.
export function classifyTraversalSpeed(speed: unknown): string {
  const value = Number(speed);
  if (!Number.isFinite(value) || value < 1.0) {
    return TRAVERSAL_SPEED_CLASSES.backtracker;
  }

  return value > 1.0 ? TRAVERSAL_SPEED_CLASSES.trailblazer : TRAVERSAL_SPEED_CLASSES.navigator;
}
