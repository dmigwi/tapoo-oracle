import { describe, expect, it } from "vitest"

import { levelSummaryRows, mazeFrameAt, mazeReplayModel, mazeSummaryRows } from "./maze-view.js"

const REAL_MAZE = {
  index_chars: ["|", "---", "-", "   ", " ", "\n"],
  structure_checksum: "0x74af82cb14470b9d",
  structure:
    "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
  dimensions: { numCols: 6, numRows: 4, area: 24 },
}

// A three-turn round through the real maze: two clean turns, then one whose second move hits a wall.
const level = ({ encodedMaze = REAL_MAZE, turns, outcome } = {}) => ({
  key: "2/1",
  game: 2,
  level: 1,
  encodedMaze,
  startCell: "0,0",
  destinationCell: { row: 0, col: 5 },
  endCell: "2,0",
  observedExits: new Map(),
  positions: [],
  turns: turns ?? [
    { turn: 0, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null },
    { turn: 1, playerName: "Katara", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null },
    {
      turn: 2,
      playerName: "Katara",
      before: "2,0",
      moves: ["MoveRight", "MoveUp"],
      applied: 1,
      cells: ["2,0", "2,1"],
      rejectedMove: "MoveUp",
    },
  ],
  outcome: outcome ?? {
    outcome: "won",
    traversalSpeed: "1.0000",
    playerUniqueCellsVisited: 17,
    decayUnitsCharged: 17,
  },
})

const modelFor = (overrides) => mazeReplayModel({ levels: [level(overrides)] })[0]

describe("mazeReplayModel", () => {
  it("decodes the maze and lists the seats that acted", () => {
    const model = modelFor()

    expect(model.error).toBeNull()
    expect(model.maze.exits.size).toBe(24)
    expect(model.agents).toEqual(["Katara"])
    expect(model.destinationCell).toBe("0,5")
  })

  it("carries the reason instead of a grid when the maze cannot be trusted", () => {
    // A grid drawn from damaged bytes would be a picture of corruption presented as evidence, so a
    // failed decode has to reach the view as an error rather than a partial maze.
    const model = modelFor({ encodedMaze: { ...REAL_MAZE, structure: `${REAL_MAZE.structure}0` } })

    expect(model.maze).toBeNull()
    expect(model.error).toMatch(/checksum/)
  })

  it("reports a round that never logged a maze", () => {
    expect(modelFor({ encodedMaze: null }).error).toMatch(/carries no encoded maze/)
  })
})

describe("mazeFrameAt", () => {
  const model = modelFor()

  it("shows only the start before any turn is played", () => {
    const frame = mazeFrameAt(model, 0)

    expect(frame.turnIndex).toBe(0)
    expect([...frame.visited.keys()]).toEqual(["0,0"])
    expect(frame.currentCell).toBe("0,0")
    expect(frame.rejected).toBeNull()
  })

  it("accumulates the path as turns are played", () => {
    expect([...mazeFrameAt(model, 1).visited.keys()]).toEqual(["0,0", "1,0"])
    expect(mazeFrameAt(model, 2).currentCell).toBe("2,0")
    expect(mazeFrameAt(model, 2).positions.get("Katara")).toBe("2,0")
  })

  it("surfaces the refused move only on the turn that produced it", () => {
    // A rejected move is an event, not a lasting property of the cell: showing it on later frames would
    // read as a wall the agent kept hitting.
    expect(mazeFrameAt(model, 2).rejected).toBeNull()
    expect(mazeFrameAt(model, 3).rejected).toEqual({ cell: "2,1", move: "MoveUp" })
  })

  it("clamps a scrub position outside the round", () => {
    expect(mazeFrameAt(model, -5).turnIndex).toBe(0)
    expect(mazeFrameAt(model, 99).turnIndex).toBe(3)
  })

  it("tracks each seat separately", () => {
    const shared = modelFor({
      turns: [
        { turn: 0, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null },
        { turn: 1, playerName: "Bumi", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null },
      ],
    })

    const frame = mazeFrameAt(shared, 2)
    expect(shared.agents).toEqual(["Katara", "Bumi"])
    expect(frame.positions.get("Katara")).toBe("1,0")
    expect(frame.positions.get("Bumi")).toBe("2,0")
  })
})

describe("mazeSummaryRows", () => {
  const value = (rows, field) => rows.find((row) => row.field === field)?.value

  it("describes the maze and how much of it was entered", () => {
    const rows = mazeSummaryRows(modelFor())

    expect(value(rows, "Maze size")).toBe("4 x 6 (24 cells)")
    expect(value(rows, "Dead ends")).toBe("6")
    expect(value(rows, "Corridors")).toBe("14")
    expect(value(rows, "Junctions")).toBe("4")
    expect(value(rows, "Shortest route")).toBe("17 moves")
    // Four distinct cells across the three turns, including the start.
    expect(value(rows, "Cells entered")).toBe("4 of 24 (17%)")
  })

  it("reports the agent-credited count separately from the cells walked", () => {
    // Tapoo credits the start cell to the "Self" pseudo-player, so the agent's own count runs one below
    // the cells its path covers. Showing both stops that gap being read as an error.
    expect(value(mazeSummaryRows(modelFor()), "Credited to agent")).toBe("17")
    expect(value(mazeSummaryRows(modelFor({ outcome: {} })), "Credited to agent")).toBe("not recorded")
  })

  it("is empty when there is no maze to describe", () => {
    expect(mazeSummaryRows(modelFor({ encodedMaze: null }))).toEqual([])
  })
})

describe("levelSummaryRows", () => {
  it("classifies speed itself rather than echoing the log's spelling", () => {
    // The log writes "navigator"; classifyTraversalSpeed writes "Navigator". Two spellings of one class
    // in a single report read as two different things.
    expect(levelSummaryRows({ levels: [level()] })).toEqual([
      { level: 1, game: 2, outcome: "won", turns: 3, speed: "1.0000", class: "Navigator" },
    ])
  })

  it("says so when a round recorded no speed", () => {
    const rows = levelSummaryRows({ levels: [level({ outcome: { outcome: "lost" } })] })

    expect(rows[0]).toMatchObject({ outcome: "lost", speed: "not recorded", class: "not recorded" })
  })
})
