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

import {MOVES, getCellKey, isMove, stepFrom} from "./geometry";
import {fnv1a64Checksum} from "./utils";
import type {CellKey, EncodedMaze, Maze, MazeResult, MazeRoutes, MazeStats, Move, OpenCellExits, Result} from "./types";

// --- Entry point: what log-contract and maze-model call ---

/** mazeFromEncoded is the one call a consumer needs: encoded field in, wall graph and stats out. */
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

  // One walk for the whole round: the stats' route length, the coverage denominator and every per-turn
  // distance all read it, and a second walk could only disagree with the first.
  const routes = routeToDestination(built.maze, destinationCell);
  const stats = mazeStats(built.maze, {startCell, routes});

  // Validate the two structural invariants that hold for any perfect maze (a spanning tree).
  //
  // edges == cells - 1: a connected acyclic graph on N nodes has exactly N-1 edges. More or fewer
  // means the maze has a cycle or a disconnected region - either breaks the guarantee that every
  // cell is reachable and that there is exactly one path between any two cells.
  //
  // deadEnds == deg3 + 2·deg4 + 2: follows from the handshaking lemma on a tree. Summing degrees
  // gives 2·edges = 2·(cells-1). Expanding by degree class and eliminating corridors (deg2) yields
  // this identity. A violation means the cell-classification counts are internally inconsistent.
  if (stats.edges !== stats.cells - 1) {
    return {ok: false, error: `Maze has cycles or disconnected regions: expected ${stats.cells - 1} edges for ${stats.cells} cells but found ${stats.edges}.`};
  }
  if (stats.deadEnds !== stats.deg3 + 2 * stats.deg4 + 2) {
    return {ok: false, error: `Maze failed dead-end invariant: expected ${stats.deg3 + 2 * stats.deg4 + 2} dead ends (deg3=${stats.deg3}, deg4=${stats.deg4}) but found ${stats.deadEnds}.`};
  }

  if (startCell && destinationCell && stats.successPathCells === null) {
    return {ok: false, error: "Maze has no navigable path from start to destination. The experiment is invalid."};
  }

  return {ok: true, maze: built.maze, grid: decoded.grid, stats, routes};
}

// --- Rendered grid geometry ---

// The distance in rendered-grid units between neighboring logical cell centers. Tapoo renders a maze
// with its walls interleaved between cells, so an R x C maze occupies a (2R+1) x (2C+1) token grid and
// logical cell (r, c) sits at [2r+1][2c+1].
const RENDER_CELL_STEP = 2;

/** cellFromGridPoint converts a logged {x, y} render-grid point to a "row,col" cell key.
 *
 * Positions in the level-started and round-end entries are render-grid points, not cells - the same
 * inverse Tapoo applies in cellCoordinateFromGridPoint. Without this the start and finishing cells read
 * as coordinates twice their real value and land outside the maze. */
export function cellFromGridPoint(point: {x?: number; y?: number} | null | undefined): CellKey | null {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return getCellKey({
    row: Math.floor((y - 1) / RENDER_CELL_STEP),
    col: Math.floor((x - 1) / RENDER_CELL_STEP),
  });
}

// isOpen reports whether a rendered token is a gap rather than a wall.
//
// Tapoo's own test is the first character being a space (isSpaceFound in frontend/app/traversal.ts): a
// horizontal opening is the three-space token "   " while a vertical one is " ", so comparing the whole
// token against a single space would read every horizontal opening as a wall.
const isOpen = (token: string | undefined): boolean =>
  typeof token === "string" && token.length > 0 && token.charCodeAt(0) === 32;

// --- Decoding the logged maze ---

/** decodeEncodedMaze expands the compact structure string back into the exact token grid Tapoo rendered.
 *
 * Returns a discriminated result rather than throwing, matching parseTapooLogText: every failure here
 * is something a reader has to be told about, not an exceptional condition. A corrupt maze must not
 * degrade into a plausible-looking grid - a maze drawn from damaged bytes would be read as evidence. */
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
// The result is OpenCellExits, the same type buildContext's context.exits carries, so a cell's true
// exits and the exits the agent was actually shown can be compared directly - which is the whole point
// of drawing the maze beside the profile.
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

  const exits: OpenCellExits = new Map();
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
      exits.set(getCellKey({row, col}), open);
    }
  }

  return {ok: true, maze: {rows, cols, exits}};
}

// --- Reading the maze ---

/** routeToDestination walks the maze breadth-first **from the destination**, and keeps both what it
 * measured and how it got there: every cell's distance, and the step that cell should take next.
 *
 * Outward from the destination rather than inward from a start, because every cell needs an answer.
 * A seat's distance changes each turn and a report asks for it at every one of them, so one walk that
 * answers for all 600 cells replaces 600 walks that each answer for one.
 *
 * One arrival per cell is the whole route. The structure is a spanning tree - mazeFromEncoded refuses
 * anything else, on the edges == cells - 1 proof above - so between any two cells there is exactly one
 * path, and the first arrival cannot be beaten later. No re-relaxation, no priority queue.
 *
 * Null where no destination was stated: a distance to nowhere is not a distance of 0, and a round that
 * never said where it was going has no route to be measured against. */
export function routeToDestination(maze: Maze, destination: CellKey | null | undefined): MazeRoutes | null {
  if (!destination || !maze.exits.has(destination)) {
    return null;
  }

  const distances = new Map<CellKey, number>([[destination, 0]]);
  const next = new Map<CellKey, CellKey>();
  const queue: CellKey[] = [destination];
  // An index rather than shift(): shift() is linear in the queue, so a 600-cell maze pays for the
  // whole queue on every cell it visits. The queue is never re-read behind the cursor.
  for (let cursor = 0; cursor < queue.length; cursor++) {
    // The loop condition guarantees an element; the assertion states that rather than widening the
    // type to include undefined at every use below.
    const cell = queue[cursor]!;
    const distance = distances.get(cell)!;
    for (const move of maze.exits.get(cell) ?? []) {
      const neighbour = stepFrom(cell, move);
      if (!maze.exits.has(neighbour) || distances.has(neighbour)) {
        continue;
      }

      distances.set(neighbour, distance + 1);
      // The cell that discovered this one is the one step nearer the destination, so it is also the
      // way out of it. Following `next` from any cell walks the route the maze admits.
      next.set(neighbour, cell);
      queue.push(neighbour);
    }
  }

  return {distances, next};
}

/** routeFrom reads the ordered cells from one cell to the destination, that cell and the destination
 * included, or null for a cell the routes do not reach.
 *
 * The list, not just its length: a coverage figure asks which cells are on the route, and a verdict
 * asks how many of them are still unvisited. Both need the cells themselves. */
export function routeFrom(routes: MazeRoutes, cell: CellKey | null | undefined): CellKey[] | null {
  if (!cell || !routes.distances.has(cell)) {
    return null;
  }

  const route: CellKey[] = [cell];
  // Bounded by the distance it started from, which falls by one at every step - a tree admits no loop
  // for this to walk forever in, and the bound says so without trusting that.
  for (let step = routes.next.get(cell); step !== undefined; step = routes.next.get(step)) {
    route.push(step);
  }

  return route;
}

/** successPathLength returns the fewest **moves** between two cells, or null when no route exists -
 * the shortest run a player could make without a wasted step.
 *
 * Moves, not cells: the start cell is distance 0, so a route of N moves passes through N + 1 cells.
 * A caller presenting this beside a cell count has to add one or say "moves".
 *
 * A lookup into the walk above rather than a walk of its own, so the two cannot disagree about what
 * the shortest route is. */
export function successPathLength(
  maze: Maze,
  fromCell: CellKey | null | undefined,
  toCell: CellKey | null | undefined,
): number | null {
  const routes = routeToDestination(maze, toCell);
  if (!routes || !fromCell) {
    return null;
  }

  return routes.distances.get(fromCell) ?? null;
}

// mazeStats summarizes the shape of the maze itself, independently of how the agent played it.
//
// The cell classes use the same thresholds Tapoo assigns (dead-end at one exit or fewer, corridor at
// two, junction at three or more), so a count here means the same thing it means in a Tapoo prompt.
function mazeStats(
  maze: Maze,
  {startCell, routes}: {startCell?: CellKey | null; routes?: MazeRoutes | null} = {},
): MazeStats {
  let deadEnds = 0;
  let corridors = 0;
  let deg3 = 0;
  let deg4 = 0;
  let edgeSum = 0;
  for (const open of maze.exits.values()) {
    edgeSum += open.size;
    if (open.size <= 1) {
      deadEnds += 1;
    } else if (open.size === 2) {
      corridors += 1;
    } else if (open.size === 3) {
      deg3 += 1;
    } else {
      deg4 += 1;
    }
  }

  return {
    rows: maze.rows,
    cols: maze.cols,
    cells: maze.exits.size,
    deadEnds,
    corridors,
    junctions: deg3 + deg4,
    deg3,
    deg4,
    edges: edgeSum / 2,
    // Moves out, cells in. The row this feeds reads "N of 120", counted against the maze's cell
    // count, so a move count there is one short in both the figure and its percentage. Converted here
    // rather than at the view, so every reader of the stat gets the same unit.
    successPathCells: (() => {
      const moves = startCell && routes ? routes.distances.get(startCell) : undefined;
      return moves === undefined ? null : moves + 1;
    })(),
  };
}
