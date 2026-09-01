// Decoding for the maze Tapoo logs once per level.
//
// A round's maze is generated from crypto.getRandomValues and is never seeded, so it cannot be
// regenerated from (level, game) after the fact - the encoded copy in the "Agent level started." entry
// is the only record of it that survives. Retries of the same level get a brand-new maze too, so the
// encoded field is per round, not per level number.
//
// This mirrors the reference decoder Tapoo keeps beside its encoder (frontend/app/logs.test.ts,
// decodeMazeForLogInTest), which exists precisely so an external analyzer can reverse the format. Keep
// the two in step: this is the consumer that decoder was written for.
//
// Like its siblings this module imports nothing from node:, so it bundles for the browser unchanged.

import {MOVES, cellKey, isMove, stepFrom} from "./log-contract";
import type {CellKey, EncodedMaze, Maze, MazeResult, MazeStats, Move, Result} from "./types";

// --- Rendered grid geometry ---

// The distance in rendered-grid units between neighboring logical cell centers. Tapoo renders a maze
// with its walls interleaved between cells, so an R x C maze occupies a (2R+1) x (2C+1) token grid and
// logical cell (r, c) sits at [2r+1][2c+1].
const RENDER_CELL_STEP = 2;

// cellFromGridPoint converts a logged {x, y} render-grid point to a "row,col" cell key.
//
// Positions in the level-started and round-end entries are render-grid points, not cells - the same
// inverse Tapoo applies in cellCoordinateFromGridPoint. Without this the start and finishing cells read
// as coordinates twice their real value and land outside the maze.
export function cellFromGridPoint(point: {x?: number; y?: number} | null | undefined): CellKey | null {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return cellKey(Math.floor((y - 1) / RENDER_CELL_STEP), Math.floor((x - 1) / RENDER_CELL_STEP));
}

// isOpen reports whether a rendered token is a gap rather than a wall.
//
// Tapoo's own test is the first character being a space (isSpaceFound in frontend/app/traversal.ts): a
// horizontal opening is the three-space token "   " while a vertical one is " ", so comparing the whole
// token against a single space would read every horizontal opening as a wall.
const isOpen = (token: string | undefined): boolean =>
  typeof token === "string" && token.length > 0 && token.charCodeAt(0) === 32;

// --- Decoding the logged maze ---

// fnv1a64Checksum is the FNV-1a 64-bit hash Tapoo stamps onto an encoded maze, over UTF-8 bytes.
// Ported rather than imported - the alternative is trusting a structure string that may have been
// truncated in transit and then rendering a maze that never existed.
export function fnv1a64Checksum(text: string): string {
  const offsetBasis = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  let hash = offsetBasis;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }

  return `0x${hash.toString(16).padStart(16, "0")}`;
}

// decodeEncodedMaze expands the compact structure string back into the exact token grid Tapoo rendered.
//
// Returns a discriminated result rather than throwing, matching parseTapooLogExport: every failure here
// is something a reader has to be told about, not an exceptional condition. A corrupt maze must not
// degrade into a plausible-looking grid - a maze drawn from damaged bytes would be read as evidence.
export function decodeEncodedMaze(encoded: EncodedMaze | null | undefined): Result<{grid: string[][]}> {
  if (!encoded || typeof encoded !== "object") {
    return {ok: false, error: "This level carries no encoded maze."};
  }

  const {index_chars: indexChars, structure, structure_checksum: checksum} = encoded;
  if (!Array.isArray(indexChars) || typeof structure !== "string") {
    return {ok: false, error: "Encoded maze is missing its index_chars or structure."};
  }

  if (checksum !== fnv1a64Checksum(structure)) {
    return {ok: false, error: "Encoded maze failed its checksum: the structure did not arrive intact."};
  }

  const rowSeparatorIndex = indexChars.indexOf("\n");
  if (rowSeparatorIndex < 0) {
    return {ok: false, error: "Encoded maze is missing a row separator token."};
  }

  const grid: string[][] = [];
  for (const encodedRow of structure.split(String(rowSeparatorIndex))) {
    const row: string[] = [];
    for (const digit of encodedRow) {
      const token = indexChars[Number(digit)];
      // A separator appearing as a cell means the split above was wrong, which would silently reshape
      // the grid rather than fail - so it is rejected here as the reference decoder does.
      if (token === undefined || token === "\n") {
        return {ok: false, error: `Encoded maze contains an invalid token index: ${digit}`};
      }
      row.push(token);
    }
    grid.push(row);
  }

  return {ok: true, grid};
}

// mazeFromDecodedGrid reduces the rendered token grid to the logical wall graph the report reasons about.
//
// The result is deliberately the same shape as buildContext's context.exits - Map of "row,col" to a Set
// of move names - so a cell's true exits and the exits the agent was actually shown can be compared
// directly, which is the whole point of drawing the maze beside the profile.
function mazeFromDecodedGrid(
  grid: string[][],
  dimensions: EncodedMaze["dimensions"],
): Result<{maze: Maze}> {
  const rows = Number(dimensions?.numRows);
  const cols = Number(dimensions?.numCols);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
    return {ok: false, error: "Encoded maze carries no usable dimensions."};
  }

  // The rendered grid's size is fixed by the logical dimensions. Checking it here means a mismatch is
  // reported as damaged input rather than silently producing a maze with missing walls.
  const expectedRows = RENDER_CELL_STEP * rows + 1;
  const expectedCols = RENDER_CELL_STEP * cols + 1;
  if (grid.length !== expectedRows || grid.some((row) => row.length !== expectedCols)) {
    return {ok: false, error: `Encoded maze does not match its ${rows}x${cols} dimensions.`};
  }

  const exits = new Map<CellKey, Set<Move>>();
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const y = RENDER_CELL_STEP * row + 1;
      const x = RENDER_CELL_STEP * col + 1;
      const open = new Set<Move>();
      for (const [move, [rowDelta, colDelta]] of Object.entries(MOVES)) {
        if (isMove(move) && isOpen(grid[y + rowDelta]?.[x + colDelta])) {
          open.add(move);
        }
      }
      exits.set(cellKey(row, col), open);
    }
  }

  return {ok: true, maze: {rows, cols, exits}};
}

// --- Reading the maze ---

// shortestPathLength walks the maze breadth-first and returns the fewest moves between two cells, or
// null when no route exists. Reported beside the agent's own path length, it is what turns "17 cells
// visited" into "17 cells visited on a 17-move route" - the difference between efficient and lucky.
export function shortestPathLength(
  maze: Maze,
  fromCell: CellKey | null | undefined,
  toCell: CellKey | null | undefined,
): number | null {
  if (!fromCell || !toCell || !maze.exits.has(fromCell) || !maze.exits.has(toCell)) {
    return null;
  }

  const queue: Array<[CellKey, number]> = [[fromCell, 0]];
  const seen = new Set<CellKey>([fromCell]);
  while (queue.length > 0) {
    // The loop condition guarantees an element; the assertion states that rather than widening the
    // tuple to include undefined at every use below.
    const [cell, distance] = queue.shift()!;
    if (cell === toCell) {
      return distance;
    }

    for (const move of maze.exits.get(cell) ?? []) {
      const next = stepFrom(cell, move);
      if (maze.exits.has(next) && !seen.has(next)) {
        seen.add(next);
        queue.push([next, distance + 1]);
      }
    }
  }

  return null;
}

// mazeStats summarizes the shape of the maze itself, independently of how the agent played it.
//
// The cell classes use the same thresholds Tapoo assigns (dead-end at one exit or fewer, corridor at
// two, junction at three or more), so a count here means the same thing it means in a Tapoo prompt.
function mazeStats(
  maze: Maze,
  {startCell, destinationCell}: {startCell?: CellKey | null; destinationCell?: CellKey | null} = {},
): MazeStats {
  let deadEnds = 0;
  let corridors = 0;
  let junctions = 0;
  for (const open of maze.exits.values()) {
    if (open.size <= 1) {
      deadEnds += 1;
    } else if (open.size === 2) {
      corridors += 1;
    } else {
      junctions += 1;
    }
  }

  return {
    rows: maze.rows,
    cols: maze.cols,
    cells: maze.exits.size,
    deadEnds,
    corridors,
    junctions,
    shortestPath: shortestPathLength(maze, startCell, destinationCell),
  };
}

// --- Entry point ---

// mazeFromEncoded is the one call a consumer needs: encoded field in, wall graph and stats out.
export function mazeFromEncoded(
  encoded: EncodedMaze | null | undefined,
  {startCell, destinationCell}: {startCell?: CellKey | null; destinationCell?: CellKey | null} = {},
): MazeResult {
  const decoded = decodeEncodedMaze(encoded);
  if (!decoded.ok) {
    return decoded;
  }

  const built = mazeFromDecodedGrid(decoded.grid, encoded?.dimensions);
  if (!built.ok) {
    return built;
  }

  return {
    ok: true,
    maze: built.maze,
    grid: decoded.grid,
    stats: mazeStats(built.maze, {startCell, destinationCell}),
  };
}
