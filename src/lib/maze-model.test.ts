import { describe, expect, it } from "vitest"

import fixtureData from "./_snapshot_/tapoo-v2.5.1-gemma4-base-agent-api-log.json" with {type: "json"}
import {turnReports} from "./log-contract"

import {decayTally, mazeFrameAt, mazeReplayModel, mazeLevelRows, mazeStructureRows} from "./maze-model"
import {agentsFromRound} from "./rounds"
import type {CellKey, EncodedMaze, PlayedRound, Outcome, TurnSummary, VisitStatus, VisitStatusByTurn, SummaryRow} from "./types"
import {sliceLogText, firstRound, must} from "./test-support";

const REAL_MAZE: EncodedMaze = {
  index_chars: ["|", "---", "-", "   ", " ", "\n"],
  structure_checksum: "0x74af82cb14470b9d",
  structure:
    "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
  dimensions: { numCols: 6, numRows: 4, area: 24 },
}

// A three-turn round through the real maze: two clean turns, then one whose second move hits a wall.
type RoundOverrides = {encodedMaze?: EncodedMaze | null; turns?: TurnSummary[]; outcome?: Outcome | null;
  visitStatusAfterTurn?: VisitStatusByTurn; historyWindowRadius?: number | null}

const DEFAULT_TURNS: TurnSummary[] = [
  { turn: 0, seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: null },
  { turn: 1, seatId: null, playerName: "Katara", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, decayCharged: null },
  {
    turn: 2,
    seatId: null,
    playerName: "Katara",
    before: "2,0",
    moves: ["MoveRight", "MoveUp"],
    applied: 1,
    cells: ["2,0", "2,1"],
    rejectedMove: "MoveUp", decayCharged: null,
  },
]

const DEFAULT_OUTCOME: Outcome = {
  outcome: "won",
  traversalSpeed: "1.0000",
  playerUniqueCellsVisited: 17,
  decayUnitsCharged: 17,
}

const level = ({encodedMaze = REAL_MAZE, turns, outcome, visitStatusAfterTurn,
  historyWindowRadius = null}: RoundOverrides = {}): PlayedRound => {
  const played = turns ?? DEFAULT_TURNS
  const ended = outcome === undefined ? DEFAULT_OUTCOME : outcome

  return {
    identity: {game: 2, level: 1},
    encodedMaze,
    startCell: "0,0",
    startPosition: null,
    historyWindowRadius,
    // A resolved cell key: buildPlayedRounds reads the logged shape - which may be {row, col} or
    // [row, col] - through the contract, so a level model never carries the raw form.
    destinationCell: "0,5",
    endCell: "2,0",
    observedExits: new Map(),
    visitStatusAfterTurn: visitStatusAfterTurn ?? turnReports<Map<CellKey, VisitStatus>>(),
    positions: [],
    turns: played,
    outcome: ended,
    // Derived the way buildPlayedRounds derives it, so these fixtures exercise the real parser rather than a
    // hand-written stand-in. No setup map: these turns come from nothing that logged a request.
    agents: agentsFromRound(new Map(), played, ended),
  }
}

// A round of n turns whose only interesting property is what each was charged.
const charged = (charges: Array<number | null>): TurnSummary[] =>
  charges.map((decayCharged, turn) => ({
    turn, seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1,
    cells: ["0,0", "1,0"], rejectedMove: null, decayCharged,
  }))

const modelFor = (overrides: RoundOverrides = {}) =>
  must(mazeReplayModel(level(overrides)), "a model for the round")

describe("mazeReplayModel", () => {
  it("decodes the maze and lists the seats that acted", () => {
    const model = modelFor()

    expect(model.error).toBeNull()
    expect(must(model.maze, "a decoded maze").exits.size).toBe(24)
    expect(model.agents.map((agent) => agent.name)).toEqual(["Katara"])
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
    // Keyed by seat, and Katara is the round's only one.
    expect(mazeFrameAt(model, 2).positions.get(0)).toBe("2,0")
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

  // Keyed by the player's name, trails, markers and colours collapse here: a seat that states its number
  // and no player answers to "", so two of them share one key - one trail walking both paths, one marker,
  // one colour, drawn as a single agent in two places.
  it("keeps two seats apart when neither states a player", () => {
    const nameless = modelFor({
      turns: [
        { turn: 0, seatId: 1, playerName: null, before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: null },
        { turn: 1, seatId: 2, playerName: null, before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, decayCharged: null },
      ],
      outcome: null,
    })

    expect(nameless.agents.map((agent) => [agent.seatId, agent.name])).toEqual([[1, ""], [2, ""]])

    const frame = mazeFrameAt(nameless, 2)
    expect(frame.positions.get(0)).toBe("1,0")
    expect(frame.positions.get(1)).toBe("2,0")
  })

  it("tracks each seat separately", () => {
    const shared = modelFor({
      turns: [
        { turn: 0, seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: null },
        { turn: 1, seatId: null, playerName: "Bumi", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, decayCharged: null },
      ],
    })

    const frame = mazeFrameAt(shared, 2)
    expect(shared.agents.map((agent) => agent.name)).toEqual(["Katara", "Bumi"])
    expect(frame.positions.get(0)).toBe("1,0")
    expect(frame.positions.get(1)).toBe("2,0")
  })
})

const value = (rows: SummaryRow[], field: string) =>
  rows.find((row) => row.field === field)?.value

// Statuses are reported per turn, and only for the cells inside that turn's history window - so a cell
// walked away from keeps the last thing said about it. The carry-forward is what makes the overlay whole
// at every scrub position, and getting it wrong is invisible except at the turn it changes.
describe("visit statuses across a scrub", () => {
  // Fixtures name the turn that CARRIED each payload, the way a log does; the store applies the offset
  // to the turn it covers, which is the whole point of it owning that rule.
  const withStatuses = (byReportingTurn: Array<[number, Array<[string, string]>]>) => {
    const reports = turnReports<Map<CellKey, VisitStatus>>()
    for (const [reportingTurn, cells] of byReportingTurn) {
      reports.record(reportingTurn, new Map(cells as Array<[CellKey, VisitStatus]>))
    }
    return modelFor({visitStatusAfterTurn: reports})
  }

  it("carries the last reported status forward to later turns", () => {
    const model = withStatuses([[1, [["0,0", "backtracking"]]]])
    expect(mazeFrameAt(model, 1).visited.get("0,0")?.status).toBe("backtracking")
    expect(mazeFrameAt(model, 3).visited.get("0,0")?.status).toBe("backtracking")
  })

  it("applies a relabel from the turn that reported it, and not before", () => {
    const model = withStatuses([
      [1, [["0,0", "explored"]]],
      [3, [["0,0", "oscillating"]]],
    ])

    expect(mazeFrameAt(model, 1).visited.get("0,0")?.status).toBe("explored")
    expect(mazeFrameAt(model, 2).visited.get("0,0")?.status).toBe("explored")
    expect(mazeFrameAt(model, 3).visited.get("0,0")?.status).toBe("oscillating")
  })

  // These payloads are tool calls the model chooses to make, so a walked cell may never have been graded
  // at all. That is null, not "explored": the weakest rung of the scale is still a grade Tapoo did not
  // issue, and the whole report rests on not inventing one.
  it("leaves a cell no payload ever named ungraded", () => {
    expect(mazeFrameAt(modelFor(), 3).visited.get("1,0")?.status).toBeNull()
  })

  // A real export produced exactly this: a cell labelled unvisited early and walked later. The reading
  // was true when written and our own walk contradicts it, so it is stale rather than usable - and a
  // stale grade is not a measurement either.
  it("leaves a walked cell ungraded when its newest reading still says unvisited", () => {
    const model = withStatuses([[1, [["1,0", "unvisited"]]]])
    expect(mazeFrameAt(model, 3).visited.get("1,0")?.status).toBeNull()
  })

  // The off-by-one this whole change is about. The map is keyed by the turn a payload describes the
  // world *after*, so a status recorded under turn N must appear on the frame that has played turn N -
  // and not on the frame before it. Uses explored -> backtracking on purpose: unvisited -> explored is
  // masked by the ungraded rule above and would pass either way, which is how this went unnoticed.
  it("applies a status on the frame whose last played turn it describes", () => {
    const model = withStatuses([
      [1, [["1,0", "explored"]]],
      [2, [["1,0", "backtracking"]]],
    ])

    expect(mazeFrameAt(model, 1).visited.get("1,0")?.status).toBe("explored")
    expect(mazeFrameAt(model, 2).visited.get("1,0")?.status).toBe("backtracking")
  })

  // Frame 0 has played nothing, so it may read only the opening payload - the one logged on turn 0, stored
  // under -1. A bound of `undefined` falls through the guard and swallows every report in the round,
  // showing the end state before a single move is drawn.
  it("shows only the opening payload before any turn is played", () => {
    const model = withStatuses([
      [0, [["0,0", "backtracking"]]],
      [1, [["1,0", "oscillating"]]],
    ])

    expect(mazeFrameAt(model, 0).visited.get("0,0")?.status).toBe("backtracking")
    expect(mazeFrameAt(model, 0).visited.has("1,0")).toBe(false)
  })

  it("keeps the seat that entered the cell alongside its status", () => {
    expect(mazeFrameAt(modelFor(), 2).visited.get("1,0")?.playerName).toBe("Katara")
  })
})

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
    // Cells, not moves: the 17-move route passes through 18 cells, and the row compares it against
    // the maze's 24 cells. Counting moves here read "17 of 24 (71%)" - one short in both halves.
    expect(value(rows, "Success path")).toBe("18 of 24 (75%)")
    // Agent-specific rows belong to the per-seat cards, not to this table.
    expect(value(rows, "Traversal speed")).toBeUndefined()
    expect(value(rows, "Progress Credited to Katara")).toBeUndefined()
  })

  // What the agent could see of its own history bounds what any verdict about its choices can fairly
  // claim, so it sits with the round's facts rather than with the maze's fixed shape.
  it("states how far the agent could see its own history", () => {
    expect(value(mazeLevelRows(modelFor({historyWindowRadius: 2})), "History window"))
      .toBe("2 cells (Manhattan radius)")
  })

  // Older exports may not carry it, and a missing radius is not a radius of zero - which would say the
  // agent saw nothing at all.
  it("says so when the radius was never recorded", () => {
    expect(value(mazeLevelRows(modelFor()), "History window")).toBe("not recorded")
  })

  it("is empty when there is no maze to describe", () => {
    expect(mazeLevelRows(modelFor({ encodedMaze: null }))).toEqual([])
  })

  // The row and the strip under the scrubber are two views of one partition. If the row could show a
  // split the bars do not draw, a reader adding the bars up would land somewhere else and be right.
  it("breaks the turn count down by what each turn was charged", () => {
    const rows = mazeLevelRows(modelFor({turns: charged([1, 1, 2])}))
    expect(value(rows, "Turns")).toBe("3 (2 + 1)")
  })

  it("shows turns no reading covered rather than folding them into a charge", () => {
    const rows = mazeLevelRows(modelFor({turns: charged([1, 3, null])}))
    expect(value(rows, "Turns")).toBe("3 (1 + 1 + 1 unreported)")
  })

  // One part is the total restated. A "3 (3)" would read as a breakdown that lost two thirds of itself.
  it("leaves the count alone when every turn paid the same charge", () => {
    expect(value(mazeLevelRows(modelFor({turns: charged([1, 1, 1])})), "Turns")).toBe("3")
    expect(value(mazeLevelRows(modelFor()), "Turns")).toBe("3")
  })
})

describe("decayTally", () => {
  it("counts turns by charge, ascending, omitting penalties the round never paid", () => {
    expect(decayTally(modelFor({turns: charged([2, 1, 2])}).turns)).toEqual({
      counts: [{charge: 1, count: 1}, {charge: 2, count: 2}],
      unreported: 0,
    })
  })

  // An unmeasured cost is not a cost of zero, and it is not a base charge either.
  it("keeps unreported turns apart from charged ones", () => {
    expect(decayTally(modelFor({turns: charged([null, null, 3])}).turns)).toEqual({
      counts: [{charge: 3, count: 1}],
      unreported: 2,
    })
  })

  // Tapoo's ceiling is three; anything above it is the same top step, not a fourth colour.
  it("folds a charge above the ceiling into the top step", () => {
    expect(decayTally(modelFor({turns: charged([5])}).turns).counts).toEqual([{charge: 3, count: 1}])
  })
})

// The per-seat figures, gathered by agentsFromRound as one record each. Formatting - "3 of 24 (13%)" -
// belongs to the replay panel, which has the maze's cell count; these assert the numbers, and
// maze-view.test.ts asserts what a reader sees.
describe("agentsFromRound", () => {
  const seatsOf = (over: Parameters<typeof level>[0] = {}) => level(over).agents

  it("reports traversal speed and cells entered for the single agent", () => {
    // outcome.agent is absent in the test fixture, so the sole agent inherits the outcome.
    const [katara] = seatsOf()

    expect(katara?.name).toBe("Katara")
    expect(katara?.traversalSpeed).toBe(1)
    // Entered, not occupied. Katara's turns walk "0,0","1,0","2,0","2,1", but "0,0" is the square she
    // was placed on - Tapoo labels it "Self" in its own history and leaves it out of the count.
    expect(katara?.uniqueCells).toBe(3)
  })

  // The check that settles the semantics rather than asserting our own arithmetic back at us: Tapoo
  // states its own figure in the outcome record, and ours has to equal it. Counting the start square
  // made this 18 against Tapoo's 17.
  it("reconciles with the unique-cell count Tapoo reports for the round", () => {
    const result = sliceLogText(JSON.stringify(fixtureData), {label: "gemma4"})
    const round = firstRound(result)
    const played = must(round.playedRound, "the fixture's only round")

    expect(played.outcome?.playerUniqueCellsVisited).toBe(17)
    expect(must(played.agents[0], "the round's only seat").uniqueCells).toBe(17)

    // And the radius the round was actually configured with, read from the same export.
    const model = must(mazeReplayModel(round.playedRound), "a model for the round")
    expect(value(mazeLevelRows(model), "History window")).toBe("2 cells (Manhattan radius)")
  })

  it("reports no decay when turns carry no charge", () => {
    // The test fixture has decayCharged: null on every turn.
    expect(seatsOf()[0]?.decayCharged).toBeNull()
  })

  it("accumulates per-turn decay per agent", () => {
    const seats = seatsOf({
      turns: [
        { turn: 0, seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: 1 },
        { turn: 1, seatId: null, playerName: "Katara", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, decayCharged: 2 },
      ],
    })

    expect(seats[0]?.decayCharged).toBe(3)
  })

  it("tracks each agent's speed, decay, and cells separately in a multi-agent level", () => {
    const seats = seatsOf({
      turns: [
        { turn: 0, seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: 1 },
        { turn: 1, seatId: null, playerName: "Bumi", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, decayCharged: 2 },
      ],
      outcome: {
        outcome: "won",
        traversalSpeed: "0.9634",
        // outcome.agent names Katara as the level winner.
        agent: {playerName: "Katara"},
        playerUniqueCellsVisited: 3,
        decayUnitsCharged: 3,
      },
    })

    expect(seats.map((seat) => seat.name)).toEqual(["Katara", "Bumi"])
    // Katara owns the outcome; Bumi does not.
    expect(seats[0]?.traversalSpeed).toBe(0.9634)
    expect(seats[1]?.traversalSpeed).toBeNull()
    expect(seats.map((seat) => seat.decayCharged)).toEqual([1, 2])
    // Each seat is credited only with what it moved into: Katara entered "1,0", Bumi entered "2,0".
    // The cell each was standing on when its turn opened belongs to whoever moved there.
    expect(seats.map((seat) => seat.uniqueCells)).toEqual([1, 1])
  })

  it("names no seat for a round whose turns name no player", () => {
    const anonymous = [
      { turn: 0, seatId: null, playerName: null, before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: null },
    ]

    expect(seatsOf({turns: anonymous})).toEqual([])
  })
})

