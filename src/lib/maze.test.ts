import { describe, expect, it } from "vitest"

import {cellFromGridPoint, decodeEncodedMaze, mazeFromEncoded, routeFrom, routeToDestination, successPathLength} from "./maze"
import {expectErr, expectOk, must} from "./test-support";

// The exact maze block from a real Tapoo export (v2.5.1, 6x4). Using the shipped bytes rather than a
// hand-built grid is the point: a fabricated fixture would prove the decoder self-consistent while
// saying nothing about whether it reads what Tapoo actually writes.
const REAL_MAZE = {
  index_chars: ["|", "---", "-", "   ", " ", "\n"],
  structure_checksum: "0x74af82cb14470b9d",
  structure:
    "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
  dimensions: { numCols: 6, numRows: 4, area: 24 },
}

const START = "0,0"
const DESTINATION = "0,5"

describe("decodeEncodedMaze", () => {
  it("expands to the rendered grid the dimensions imply", () => {
    const decoded = decodeEncodedMaze(REAL_MAZE)

    expect(decoded.ok).toBe(true)
    // (2R+1) rows of (2C+1) tokens, the layout Tapoo's renderCellStep of 2 produces.
    expect(expectOk(decoded).grid).toHaveLength(9)
    expect(new Set(expectOk(decoded).grid.map((row: string[]) => row.length))).toEqual(new Set([13]))
  })

  it.each([
    ["a missing maze", undefined, /carries no encoded maze/],
    ["a damaged structure", { ...REAL_MAZE, structure: `${REAL_MAZE.structure}0` }, /checksum/],
    ["no row separator", { ...REAL_MAZE, index_chars: ["|", "---", "-", "   ", " "] }, /row separator/],
    ["an unknown token index", { ...REAL_MAZE, index_chars: ["|", "\n"] }, /checksum|invalid token/],
  ])("refuses %s", (_label, encoded, expected) => {
    const decoded = decodeEncodedMaze(encoded)

    expect(decoded.ok).toBe(false)
    expect(expectErr(decoded).error).toMatch(expected)
  })
})

describe("mazeFromEncoded", () => {
  const built = mazeFromEncoded(REAL_MAZE, { startCell: START, destinationCell: DESTINATION })

  it("recovers one exit set per logical cell", () => {
    expect(built.ok).toBe(true)
    expect(expectOk(built).maze.exits.size).toBe(24)
  })

  it.each([
    ["0,0", ["MoveDown"]],
    ["1,0", ["MoveUp", "MoveDown"]],
    // The cell V4 turns on: the agent submitted MoveUp from here and the maze has no exit that way.
    ["1,5", ["MoveDown", "MoveLeft"]],
    ["2,5", ["MoveUp", "MoveDown"]],
  ])("reads the exits of %s", (cell, expected) => {
    expect([...(expectOk(built).maze.exits.get(cell) ?? [])].sort()).toEqual([...expected].sort())
  })

  it("classifies every cell and finds the route", () => {
    expect(expectOk(built).stats).toMatchObject({
      rows: 4,
      cols: 6,
      cells: 24,
      deadEnds: 6,
      corridors: 14,
      junctions: 4,
      deg3: 4,
      deg4: 0,
      edges: 23,
      successPathCells: 18,
    })
  })

  it("satisfies structural invariants: edges == cells - 1 and deadEnds == deg3 + 2·deg4 + 2", () => {
    const {stats} = expectOk(built)

    expect(stats.edges).toBe(stats.cells - 1)
    expect(stats.deadEnds).toBe(stats.deg3 + 2 * stats.deg4 + 2)
  })

  it("rejects a grid that does not match its stated dimensions", () => {
    const built = mazeFromEncoded({ ...REAL_MAZE, dimensions: { numRows: 9, numCols: 9 } })

    expect(built.ok).toBe(false)
    expect(expectErr(built).error).toMatch(/does not match its 9x9 dimensions/)
  })

  it("rejects a maze where start and destination have no navigable path", () => {
    const built = mazeFromEncoded(REAL_MAZE, { startCell: START, destinationCell: "99,99" })

    expect(built.ok).toBe(false)
    expect(expectErr(built).error).toMatch(/no navigable path/)
  })
})

describe("successPathLength", () => {
  const {maze} = expectOk(mazeFromEncoded(REAL_MAZE))

  it("is zero between a cell and itself", () => {
    expect(successPathLength(maze, START, START)).toBe(0)
  })

  it("is null for a cell outside the maze", () => {
    expect(successPathLength(maze, START, "99,99")).toBeNull()
  })

  // The two units, pinned against each other. successPathLength counts moves - a cell to itself is
  // zero of them - while the stat the report displays counts the cells those moves pass through, which
  // is one more. The report prints it beside the maze's cell count, so a move count there understates
  // both the figure and its coverage percentage by exactly one cell.
  it("is one move fewer than the cells the stat counts", () => {
    const {stats} = expectOk(mazeFromEncoded(REAL_MAZE, {startCell: START, destinationCell: DESTINATION}))
    const moves = successPathLength(maze, START, DESTINATION)

    expect(moves).not.toBeNull()
    expect(stats.successPathCells).toBe((moves as number) + 1)
  })
})

describe("cellFromGridPoint", () => {
  it.each([
    [{ x: 1, y: 1 }, "0,0"],
    // The finishing point of the real round: render point (11,1) is cell (0,5), the destination.
    [{ x: 11, y: 1 }, "0,5"],
  ])("converts render point %j", (point, expected) => {
    expect(cellFromGridPoint(point)).toBe(expected)
  })

  it("returns null for a point that is not one", () => {
    expect(cellFromGridPoint(undefined)).toBeNull()
    expect(cellFromGridPoint({x: "left", y: 1} as unknown as {x: number; y: number})).toBeNull()
  })
})

// One walk from the destination answers for every cell, which is what a per-turn distance needs: the
// seat stands somewhere new each turn, and a report asks how far that is from the target on all of them.
describe("routeToDestination", () => {
  const {maze} = expectOk(mazeFromEncoded(REAL_MAZE))

  it("measures the destination as zero moves from itself", () => {
    const routes = must(routeToDestination(maze, DESTINATION), "routes to the destination")

    expect(routes.distances.get(DESTINATION)).toBe(0)
    // And it is the one cell with nowhere further to step.
    expect(routes.next.has(DESTINATION)).toBe(false)
  })

  // Every cell, not the reachable few: the maze is a spanning tree, so a cell missing from this would be
  // a cell the structure cannot reach, which mazeFromEncoded already refuses to decode.
  it("answers for every cell of the maze", () => {
    const routes = must(routeToDestination(maze, DESTINATION), "routes to the destination")

    expect(routes.distances.size).toBe(maze.exits.size)
  })

  // The distance is the route's, not the grid's. "0,3" sits two columns from the destination on the same
  // row - a Manhattan estimate says 2 - and the maze's only way there is 10 moves, back out through the
  // corridor it shares with the start. That gap is why the distance is walked rather than estimated.
  it("measures along the maze rather than across the grid", () => {
    const routes = must(routeToDestination(maze, DESTINATION), "routes to the destination")

    expect(routes.distances.get("0,3")).toBe(10)
    expect(routes.distances.get(START)).toBe(17)
  })

  it("has no routes where the round stated no destination", () => {
    expect(routeToDestination(maze, null)).toBeNull()
    expect(routeToDestination(maze, "99,99")).toBeNull()
  })

  // The same walk both ways: the stat the report prints is this distance in cells rather than moves, so
  // one of them being wrong is the two disagreeing.
  it("agrees with the length the stats report", () => {
    const routes = must(routeToDestination(maze, DESTINATION), "routes to the destination")
    const {stats} = expectOk(mazeFromEncoded(REAL_MAZE, {startCell: START, destinationCell: DESTINATION}))

    expect(stats.successPathCells).toBe(must(routes.distances.get(START), "the start's distance") + 1)
  })
})

// The cells themselves, not just how many: coverage asks which cells are on the route, and the verdict
// asks how many of them are still unvisited.
describe("routeFrom", () => {
  const {maze} = expectOk(mazeFromEncoded(REAL_MAZE))
  const routes = must(routeToDestination(maze, DESTINATION), "routes to the destination")

  it("walks the route from a cell to the destination, both included", () => {
    const route = must(routeFrom(routes, START), "a route from the start")

    expect(route.at(0)).toBe(START)
    expect(route.at(-1)).toBe(DESTINATION)
    // 17 moves pass through 18 cells.
    expect(route).toHaveLength(18)
    // Every step is a move the maze allows, and every cell is one nearer than the last.
    for (const [index, cell] of route.entries()) {
      expect(routes.distances.get(cell)).toBe(route.length - 1 - index)
    }
  })

  it("is the destination alone from the destination", () => {
    expect(routeFrom(routes, DESTINATION)).toEqual([DESTINATION])
  })

  it("is null for a cell the routes do not reach", () => {
    expect(routeFrom(routes, "99,99")).toBeNull()
    expect(routeFrom(routes, null)).toBeNull()
  })
})
