import { describe, expect, it } from "vitest"

import {mazeFrameAt, mazeReplayModel, mazeLevelRows, mazeLevelAgentStats, mazeStructureRows} from "./maze-model"
import type {EncodedMaze, Level, Outcome, Turn} from "./types"
import {must, reportWith} from "./test-support";

const REAL_MAZE: EncodedMaze = {
  index_chars: ["|", "---", "-", "   ", " ", "\n"],
  structure_checksum: "0x74af82cb14470b9d",
  structure:
    "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
  dimensions: { numCols: 6, numRows: 4, area: 24 },
}

// A three-turn round through the real maze: two clean turns, then one whose second move hits a wall.
type LevelOverrides = {encodedMaze?: EncodedMaze | null; turns?: Turn[]; outcome?: Outcome | null}

const level = ({encodedMaze = REAL_MAZE, turns, outcome}: LevelOverrides = {}): Level => ({
  key: "2/1",
  game: 2,
  level: 1,
  encodedMaze,
  startCell: "0,0",
  startPosition: null,
  historyWindowRadius: null,
  // A resolved cell key: buildLevels reads the logged shape - which may be {row, col} or
  // [row, col] - through the contract, so a level model never carries the raw form.
  destinationCell: "0,5",
  endCell: "2,0",
  observedExits: new Map(),
  positions: [],
  turns: turns ?? [
    { turn: 0, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: null },
    { turn: 1, playerName: "Katara", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, decayCharged: null },
    {
      turn: 2,
      playerName: "Katara",
      before: "2,0",
      moves: ["MoveRight", "MoveUp"],
      applied: 1,
      cells: ["2,0", "2,1"],
      rejectedMove: "MoveUp", decayCharged: null,
    },
  ],
  outcome: outcome ?? {
    outcome: "won",
    traversalSpeed: "1.0000",
    playerUniqueCellsVisited: 17,
    decayUnitsCharged: 17,
  },
})

const modelFor = (overrides: LevelOverrides = {}) =>
  must(mazeReplayModel(reportWith(level(overrides)))[0], "a model for the round")

describe("mazeReplayModel", () => {
  it("decodes the maze and lists the seats that acted", () => {
    const model = modelFor()

    expect(model.error).toBeNull()
    expect(must(model.maze, "a decoded maze").exits.size).toBe(24)
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
        { turn: 0, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: null },
        { turn: 1, playerName: "Bumi", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, decayCharged: null },
      ],
    })

    const frame = mazeFrameAt(shared, 2)
    expect(shared.agents).toEqual(["Katara", "Bumi"])
    expect(frame.positions.get("Katara")).toBe("1,0")
    expect(frame.positions.get("Bumi")).toBe("2,0")
  })
})

const value = (rows: {field: string; value: string}[], field: string) =>
  rows.find((row) => row.field === field)?.value

describe("mazeStructureRows", () => {
  it("describes the static maze topology", () => {
    const rows = mazeStructureRows(modelFor())

    expect(value(rows, "Maze size")).toBe("4 x 6 (24 cells)")
    expect(value(rows, "Edges")).toBe("23")
    expect(value(rows, "Dead ends")).toBe("6")
    expect(value(rows, "Corridors")).toBe("14")
    expect(value(rows, "3-exit junctions (deg3)")).toBe("4")
    expect(value(rows, "4-exit junctions (deg4)")).toBe("0")
    expect(value(rows, "Acyclic graph proof")).toBe("Edges = Maze_size - 1 = 23")
    expect(value(rows, "Handshaking lemma proof")).toBe("Dead ends = deg3 + 2·deg4 + 2 = 6")
  })

  it("is empty when there is no maze to describe", () => {
    expect(mazeStructureRows(modelFor({ encodedMaze: null }))).toEqual([])
  })
})

describe("mazeLevelRows", () => {
  it("describes the round-level facts that belong to the level as a whole", () => {
    const rows = mazeLevelRows(modelFor())

    expect(value(rows, "Outcome")).toBe("won")
    expect(value(rows, "Turns")).toBe("3")
    expect(value(rows, "Success route")).toBe("17 of 24 (71%)")
    // Agent-specific rows are no longer in mazeLevelRows.
    expect(value(rows, "Traversal speed")).toBeUndefined()
    expect(value(rows, "Progress Credited to Katara")).toBeUndefined()
  })

  it("is empty when there is no maze to describe", () => {
    expect(mazeLevelRows(modelFor({ encodedMaze: null }))).toEqual([])
  })
})

describe("mazeLevelAgentStats", () => {
  it("reports traversal speed and cells entered for the single agent", () => {
    // outcome.agent is absent in the test fixture, so the sole agent inherits the outcome.
    const stats = mazeLevelAgentStats(modelFor())!

    expect(stats.agents).toEqual(["Katara"])
    expect(stats.traversalSpeeds).toEqual(["Navigator (1.0000)"])
    // Katara's turns cover "0,0","1,0","2,0","2,1" — four unique cells.
    expect(stats.cellsEntered).toEqual(["4 of 24 (17%)"])
  })

  it("reports not-recorded decay when turns carry no charge", () => {
    // The test fixture has decayCharged: null on every turn.
    const stats = mazeLevelAgentStats(modelFor())!
    expect(stats.decayCharged).toEqual(["not recorded"])
  })

  it("accumulates per-turn decay per agent", () => {
    const stats = mazeLevelAgentStats(modelFor({
      turns: [
        { turn: 0, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: 1 },
        { turn: 1, playerName: "Katara", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, decayCharged: 2 },
      ],
    }))!

    expect(stats.decayCharged).toEqual(["3"])
  })

  it("tracks each agent's speed, decay, and cells separately in a multi-agent level", () => {
    const stats = mazeLevelAgentStats(modelFor({
      turns: [
        { turn: 0, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: 1 },
        { turn: 1, playerName: "Bumi", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, decayCharged: 2 },
      ],
      outcome: {
        outcome: "won",
        traversalSpeed: "0.9634",
        // outcome.agent names Katara as the level winner.
        agent: {playerName: "Katara"},
        playerUniqueCellsVisited: 3,
        decayUnitsCharged: 3,
      },
    }))!

    expect(stats.agents).toEqual(["Katara", "Bumi"])
    // Katara owns the outcome; Bumi does not.
    expect(stats.traversalSpeeds[0]).toMatch(/0\.9634/)
    expect(stats.traversalSpeeds[1]).toBe("not recorded")
    expect(stats.decayCharged).toEqual(["1", "2"])
    // Katara: "0,0","1,0" → 2 cells. Bumi: "1,0","2,0" → 2 cells (1,0 counted once per agent).
    expect(stats.cellsEntered[0]).toMatch(/^2 of/)
    expect(stats.cellsEntered[1]).toMatch(/^2 of/)
  })

  it("is null when there is no maze to describe", () => {
    expect(mazeLevelAgentStats(modelFor({ encodedMaze: null }))).toBeNull()
  })
})

