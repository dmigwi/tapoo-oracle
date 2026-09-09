// Maze geometry and traversal speed: the pure arithmetic of Tapoo's grid.
//
// Its own module so maze.ts can use it without importing the log contract. The contract needs to
// validate an encoded maze - which means decoding one - and maze.ts needed getCellKey and stepFrom from
// the contract, so leaving these there made the two files import each other.
//
// Nothing here reads a log or answers a question. It converts between the shapes a cell arrives in and
// the key the rest of the app uses, and it steps one cell to the next.

import type {Cell, CellKey, LoggedCell, Move, VisitStatus} from "./types";

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
export const isMove = (value: unknown): value is Move => typeof value === "string" && Object.hasOwn(MOVES, value);

/** getCellKey builds the `"row,col"` key a cell travels as when it is a Map or Set key.
 *
 * Takes a cell rather than two loose numbers, so the argument order cannot be swapped silently - a
 * transposed `(col, row)` call produced a key that looked entirely valid and addressed the wrong
 * square. It accepts either logged shape, so a caller holding a cell straight out of a log does not
 * have to normalise it first.
 *
 * Cells are keys because Maps and Sets compare arrays by identity, which would make every lookup miss. */
export const getCellKey = (cell: LoggedCell): CellKey =>
  Array.isArray(cell) ? `${cell[0]},${cell[1]}` : `${(cell as Cell).row},${(cell as Cell).col}`;

/** cellFromKey reads a key back into coordinates - the one place that undoes getCellKey.
 *
 * Throws on a key it cannot parse, because that is a programming error rather than log data: a key only
 * exists if getCellKey built it. Callers reading coordinates out of *log* input want cellFromLogged,
 * which returns null instead, because there the malformed value is somebody else's. */
export const cellFromKey = (key: CellKey): Cell => {
  const [row, col] = key.split(",").map(Number);
  if (row === undefined || col === undefined || Number.isNaN(row) || Number.isNaN(col)) {
    throw new Error(`not a cell key: ${key}`);
  }
  return {row, col};
};

/** cellFromLogged reads either shape a logged cell arrives in into validated coordinates, or null
 * when it is neither.
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
export function cellFromLogged(cell: unknown): Cell | null {
  if (Array.isArray(cell)) {
    const [row, col] = cell as unknown[];
    return typeof row === "number" && typeof col === "number" ? {row, col} : null;
  }

  if (cell !== null && typeof cell === "object" && "row" in cell && "col" in cell) {
    const {row, col} = cell;
    return typeof row === "number" && typeof col === "number" ? {row, col} : null;
  }

  return null;
}

/** openMovesFromLogged returns the set of moves a cell's *open exits* allow, from either logged shape:
 * the uncompacted object keyed by move name, or the compacted [move, visitStatus] pairs.
 *
 * A Set, so a move named twice is counted once. That is right for the question this answers - a cell
 * either has an exit in a direction or it does not, and openMoves is a description of the cell rather
 * than a sequence of events. It is wrong for any caller that needs to count occurrences or preserve
 * order, and the name says "openMoves" rather than "moves" so that a caller reaching for a *submitted*
 * move list, where a repeat is the finding, does not land here by mistake. C1.Q3 and V6 both read
 * submitted moves; neither uses this.
 *
 * `Move`, not `string`, for the same reason as statusesFromLogged: a caller's next act is to hand one
 * to stepFrom or to test it against a maze's own exits, both of which speak Move. A name the maze
 * cannot apply is dropped at the parse rather than guarded against at each use.
 *
 * That narrowing is also what makes this the same shape as `Maze.exits`, which the decoded maze
 * produces - the observed exits and the structural ones can now be compared without a coercion between
 * them.
 *
 * Reading the compacted form with Object.keys yields array indices - "0", "1" - which match no move
 * command, so every exit check silently failed. That failure is now a dropped entry rather than a
 * member of the returned set.
 *
 * `unknown` for the same reason as cellFromLogged: the value comes straight from a parsed log. */
export function openMovesFromLogged(openMoves: unknown): Set<Move> {
  if (Array.isArray(openMoves)) {
    return new Set(
      (openMoves as unknown[])
        .map((entry) => (Array.isArray(entry) ? (entry as unknown[])[0] : entry))
        .filter(isMove),
    );
  }

  return new Set(Object.keys(openMoves ?? {}).filter(isMove));
}

/** cellKeyFromLogged is cellFromLogged followed by getCellKey, for a caller whose destination is a key.
 *
 * Kept as its own name rather than left to each call site: composing the two by hand is three lines and
 * a null check every time, and the two orderings a caller could write - key the null, or null the key -
 * are not the same. A cell that is not a cell has no key. */
export const cellKeyFromLogged = (cell: unknown): CellKey | null => {
  const parsed = cellFromLogged(cell);
  return parsed === null ? null : getCellKey(parsed);
};

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
 * Both logged shapes carry it and both are read here. openMovesFromLogged above drops it from each -
 * taking only entry[0] from a compacted pair, and only the keys of the uncompacted object - which is
 * correct for a caller that wants exits and is why this is a separate reader rather than a wider
 * return type.
 *
 * The move is narrowed to `Move` here rather than returned as a string. Every caller's next act is to
 * resolve the neighbour with stepFrom, which takes a Move, so a `string` tuple made each of them repeat
 * an `isMove` guard - validation that belongs with the parse, not with each use of it. A key naming
 * something the maze cannot apply is dropped, exactly as those guards dropped it. */
export function statusesFromLogged(openMoves: unknown): Array<[Move, VisitStatus]> {
  const pairs: Array<[Move, VisitStatus]> = [];

  if (Array.isArray(openMoves)) {
    // Compacted: [move, visitStatus].
    for (const entry of openMoves as unknown[]) {
      if (!Array.isArray(entry)) continue;
      const [move, status] = entry as unknown[];
      const known = asVisitStatus(status);
      if (isMove(move) && known) pairs.push([move, known]);
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
    if (isMove(move) && known) pairs.push([move, known]);
  }

  return pairs;
}

/** stepFrom resolves the cell reached by applying one move command to a `"row,col"` key.
 *
 * Key in, key out, because both of its callers are addressing a Map. The coordinates it works in are
 * read and rebuilt by cellFromKey and getCellKey, so the arithmetic exists once - and a key it cannot
 * parse throws, since every key it receives was built by getCellKey. */
export function stepFrom(key: CellKey, move: Move): CellKey {
  const {row, col} = cellFromKey(key);
  const [rowDelta, colDelta] = MOVES[move];
  return getCellKey({row: row + rowDelta, col: col + colDelta});
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
