import { describe, expect, it } from "vitest"

import {cellFromGridPoint, decodeEncodedMaze, fnv1a64Checksum, mazeFromEncoded, shortestPathLength} from "./maze"
import {expectErr, expectOk} from "./test-support";

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

describe("fnv1a64Checksum", () => {
  it("reproduces the checksum Tapoo stamped on a real maze", () => {
    expect(fnv1a64Checksum(REAL_MAZE.structure)).toBe(REAL_MAZE.structure_checksum)
  })

  it("changes when the structure changes", () => {
    expect(fnv1a64Checksum(`${REAL_MAZE.structure}0`)).not.toBe(REAL_MAZE.structure_checksum)
  })
})

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
      shortestPath: 17,
    })
  })

  it("rejects a grid that does not match its stated dimensions", () => {
    const built = mazeFromEncoded({ ...REAL_MAZE, dimensions: { numRows: 9, numCols: 9 } })

    expect(built.ok).toBe(false)
    expect(expectErr(built).error).toMatch(/does not match its 9x9 dimensions/)
  })
})

describe("shortestPathLength", () => {
  const {maze} = expectOk(mazeFromEncoded(REAL_MAZE))

  it("is zero between a cell and itself", () => {
    expect(shortestPathLength(maze, START, START)).toBe(0)
  })

  it("is null for a cell outside the maze", () => {
    expect(shortestPathLength(maze, START, "99,99")).toBeNull()
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
