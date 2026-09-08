// Maze geometry and traversal speed: the pure arithmetic of Tapoo's grid.
//
// Its own module so maze.ts can use it without importing the log contract. The contract needs to
// validate an encoded maze - which means decoding one - and maze.ts needed cellKey and stepFrom from
// the contract, so leaving these there made the two files import each other.
//
// Nothing here reads a log or answers a question. It converts between the shapes a cell arrives in and
// the key the rest of the app uses, and it steps one cell to the next.

import type {CellKey, Move, VisitStatus} from "./types";

// --- Maze geometry ---

/** MOVES maps each accepted move command to its [row, col] delta. The four keys are also the complete
 * set of valid commands, which is what C1.Q3 checks against. */
export const MOVES: Record<Move, readonly [number, number]> = {
  MoveUp: [-1, 0],
  MoveDown: [1, 0],
  MoveLeft: [0, -1],
  MoveRight: [0, 1],
};

/** isMove narrows a string out of a log to a command the maze can actually apply.
 *
 * This guard is why stepFrom can take a Move rather than a string. A log's openMoves field is prose
 * from a model's turn, so it can name anything; before, the one caller that did not check
 * (availableContextDisregard) reached MOVES[move] with an unrecognized name, destructured undefined,
 * and threw out of the whole report. */
export const isMove = (value: unknown): value is Move =>
  typeof value === "string" && Object.hasOwn(MOVES, value);

/** Builds the `"row,col"` key every cell travels as. Cells are Map/Set keys, and arrays compare by
 * identity, which would make every lookup miss. */
export const cellKey = (row: number, col: number): CellKey => `${row},${col}`;

/** cellFromLogged reads either shape a logged cell arrives in, or null when it is neither.
 *
 * A downloaded log compacts every get_maze_structure result before writing it, turning {row, col}
 * into [row, col]. Both shapes are real, so this is the one place that decides which is which -
 * every field carrying a logged cell goes through here. Handling it per-caller is what previously
 * produced "undefined,undefined" keys: one reader was taught the compact form and another, reading a
 * different field, was not.
 *
 * The parameter is `unknown`, not LoggedCell: every caller reads this straight out of parsed JSON,
 * where the value is whatever the producer wrote. Taking the narrow type would only move the cast to
 * each call site - and a cast at a call site is a claim about untrusted data that nothing checked. */
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

/** movesFromLogged returns the move names a cell's exits allow, from either logged shape: the
 * uncompacted object keyed by move name, or the compacted [move, visitStatus] pairs.
 *
 * Reading the compacted form with Object.keys yields array indices - "0", "1" - which match no move
 * command, so every exit check silently failed.
 *
 * `unknown` for the same reason as cellFromLogged: the value comes straight from a parsed log. */
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

const VISIT_STATUSES = new Set(["unvisited", "explored", "backtracking", "oscillating"]);

const asVisitStatus = (value: unknown): VisitStatus | null =>
  typeof value === "string" && VISIT_STATUSES.has(value) ? (value as VisitStatus) : null;

/** statusesFromLogged reads what a cell's openMoves say about the cells they lead to.
 *
 * The status belongs to the *reached* cell, not to the cell that owns the entry - Tapoo's own wording is
 * "every openMoves entry ... includes the reached cell's visitStatus". A history entry carries no status
 * of its own; across the snapshot log its only keys are cell, openMoves and playerName. So a cell learns
 * its status from whichever neighbour points back at it, and the caller resolves the move with stepFrom.
 *
 * Both logged shapes carry it and both are read here. movesFromLogged above drops it from each - taking
 * only entry[0] from a compacted pair, and only the keys of the uncompacted object - which is correct
 * for a caller that wants exits and is why this is a separate reader rather than a wider return type. */
export function statusesFromLogged(openMoves: unknown): Array<[string, VisitStatus]> {
  const pairs: Array<[string, VisitStatus]> = [];

  if (Array.isArray(openMoves)) {
    // Compacted: [move, visitStatus].
    for (const entry of openMoves as unknown[]) {
      if (!Array.isArray(entry)) continue;
      const [move, status] = entry as unknown[];
      const known = asVisitStatus(status);
      if (typeof move === "string" && move.length > 0 && known) pairs.push([move, known]);
    }
    return pairs;
  }

  // Uncompacted: {move: {row, col, visitStatus}}.
  for (const [move, value] of Object.entries((openMoves ?? {}) as Record<string, unknown>)) {
    const known = asVisitStatus(
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).visitStatus
        : null,
    );
    if (move.length > 0 && known) pairs.push([move, known]);
  }

  return pairs;
}

/** stepFrom resolves the cell reached by applying one move command to a `"row,col"` key.
 *
 * Throws on a key it cannot parse: every key it receives was built by cellKey, so a malformed one is a
 * programming error rather than log data. */
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

/** classifyTraversalSpeed applies the rubric's three-way split. A non-positive or non-finite speed
 * resolves to Backtracker rather than defaulting upward - the rubric is explicit that a missing
 * denominator must never produce a Trailblazer result. */
export function classifyTraversalSpeed(speed: unknown): string {
  const value = Number(speed);
  if (!Number.isFinite(value) || value < 1.0) {
    return TRAVERSAL_SPEED_CLASSES.backtracker;
  }

  return value > 1.0 ? TRAVERSAL_SPEED_CLASSES.trailblazer : TRAVERSAL_SPEED_CLASSES.navigator;
}
