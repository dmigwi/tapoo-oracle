import { describe, expect, it } from "vitest"

import fixtureData from "./_snapshot_/tapoo-v2.6.1-agent-api-logs-1789240357.json" with {type: "json"}
import {turnReports} from "./log-contract"

import {decayTally, finalScore, mazeFrameAt, mazeReplayModel, mazeLevelRows, mazeSurvivalRows, roundPlayed, routeCells, survivalLedgerFor, survivalOutlookFor} from "./maze-model"
import {decomposeTraversalSpeed} from "./geometry"
import {agentsFromRound} from "./rounds"
import {roundReportFor} from "./rubric-report"
import type {CellKey, EncodedMaze, Move, Outcome, PlayedRound, SummaryRow, TurnSummary, VisitStatus, VisitStatusByTurn} from "./types"
import {at, sliceLogText, expectOk, firstRound, must} from "./test-support";

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
  { turn: 0, seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, traversalSpeed: null, decayCharged: null, decayRemaining: null , score: null},
  { turn: 1, seatId: null, playerName: "Katara", before: "1,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, traversalSpeed: null, decayCharged: null, decayRemaining: null , score: null},
  {
    turn: 2,
    seatId: null,
    playerName: "Katara",
    before: "2,0",
    moves: ["MoveRight", "MoveUp"] as Move[], submittedCount: 2,
    applied: 1,
    cells: ["2,0", "2,1"],
    rejectedMove: "MoveUp", traversalSpeed: null, decayCharged: null, decayRemaining: null, score: null,
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
    turn, seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1,
    cells: ["0,0", "1,0"], rejectedMove: null, traversalSpeed: null, decayCharged, decayRemaining: null, score: null,
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
        { turn: 0, seatId: 1, playerName: null, before: "0,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, traversalSpeed: null, decayCharged: null, decayRemaining: null , score: null},
        { turn: 1, seatId: 2, playerName: null, before: "1,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, traversalSpeed: null, decayCharged: null, decayRemaining: null , score: null},
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
        { turn: 0, seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, traversalSpeed: null, decayCharged: null, decayRemaining: null , score: null},
        { turn: 1, seatId: null, playerName: "Bumi", before: "1,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, traversalSpeed: null, decayCharged: null, decayRemaining: null , score: null},
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

  it("describes the static maze topology in the same list", () => {
    const rows = mazeLevelRows(modelFor())

    expect(value(rows, "Maze size")).toBe("4 x 6 (24 cells)")
    expect(value(rows, "Edges")).toBe("23")
    expect(value(rows, "Dead ends")).toBe("6")
    expect(value(rows, "Corridors")).toBe("14")
    expect(value(rows, "3-exit junctions (deg3)")).toBe("4")
    expect(value(rows, "4-exit junctions (deg4)")).toBe("0")
    expect(value(rows, "Acyclic graph proof")).toBe("Edges = Maze_size - 1 = 23")
    expect(value(rows, "Handshaking lemma proof")).toBe("Dead ends = deg3 + 2·deg4 + 2 = 6")
  })

  // The order the rows read in, which is the point of merging the two lists: what the round did, then the
  // ground it did it on, then the proofs that the ground was a valid maze. A success path is a fraction of
  // the cell count directly above it, and neither figure has to be carried across a gap to check it.
  it("lists what the round did, then the maze, then the proofs", () => {
    expect(mazeLevelRows(modelFor()).map((row) => row.field)).toEqual([
      "Outcome",
      "Turns",
      "Success path",
      "History window",
      "Maze size",
      "Dead ends",
      "Edges",
      "Corridors",
      "3-exit junctions (deg3)",
      "4-exit junctions (deg4)",
      "Acyclic graph proof",
      "Handshaking lemma proof",
    ])
  })

  // The outcome with the score the round ended on. The word alone says whether it finished and nothing
  // about how it went - two unfinished rounds, one stopped at 6,700 and one at 0, read identically.
  it("states the score the round ended on beside how it ended", () => {
    const sliced = expectOk(sliceLogText(JSON.stringify(fixtureData), {label: "v2.6.1 snapshot"}))
    const won = must(mazeReplayModel(must(firstRound(sliced).playedRound, "the won round")), "a model")

    // The entry that closed the round states 300, where the last turn's own reading still said 400: the
    // closing figure is the settled one, so it wins over the running total that preceded it.
    expect(value(mazeLevelRows(won), "Outcome")).toBe("won (final scores: 300)")
    expect(finalScore(won)).toBe(300)
  })

  // An unfinished round has no closing entry, so the last turn that reported a score is the only score
  // there is. Later turns that reported nothing cannot lower it and do not stand in for it.
  it("falls back to the last turn that reported a score where the round never closed", () => {
    const sliced = expectOk(sliceLogText(JSON.stringify(fixtureData), {label: "v2.6.1 snapshot"}))
    const stopped = must(
      mazeReplayModel(must(roundReportFor(at(sliced.rounds, 1)).report.playedRound, "the stopped round")),
      "a model",
    )

    expect(value(mazeLevelRows(stopped), "Outcome")).toBe("unfinished (final scores: 3,700)")
  })

  // Zero is a score a round can genuinely end on - both rounds that ended at a standstill in the captures
  // recorded exactly that - so it is printed rather than read as an absence.
  it("prints a final score of zero rather than treating it as none", () => {
    const model = must(mazeReplayModel({...level(), outcome: {outcome: "lost", score: "0"}}), "a model")

    expect(value(mazeLevelRows(model), "Outcome")).toBe("lost (final scores: 0)")
  })

  // And nothing in parentheses where no reading states a score at all: the v2.4.8 shape has rounds that
  // state none anywhere, and an invented 0 there would be a measurement nothing took.
  it("says only how the round ended where nothing stated a score", () => {
    const model = must(mazeReplayModel(level()), "a model")

    expect(finalScore(model)).toBeNull()
    expect(value(mazeLevelRows(model), "Outcome")).toBe("won")
  })

  // A route that was never computed is not a route of no length. The row read "0 of 24 (0%)" for a round
  // that stated no destination - a measured-looking zero, from a null the formatter turned into one.
  it("says nothing about a route where the round stated no destination", () => {
    const rows = mazeLevelRows(must(mazeReplayModel({...level(), destinationCell: null}), "a model"))

    expect(value(rows, "Success path")).toBe("not recorded")
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

  // The check that settles the semantics rather than asserting our own arithmetic back at us: Tapoo states
  // its own figure in the outcome record, and ours has to equal it. Counting the start square made this 18
  // against Tapoo's 17 on the round this capture replaced.
  //
  // Counted here off the walk rather than read off the seat. A completed round copies the outcome's totals
  // onto the seat that finished it, so `agents[0].uniqueCells` is Tapoo's own figure by then - asserting it
  // against the record it came from would compare a number with itself and hold however far our counting
  // drifted. The union below is derived from nothing but the turns, which is what makes this a check.
  it("reconciles with the unique-cell count Tapoo reports for the round", () => {
    const result = sliceLogText(JSON.stringify(fixtureData), {label: "v2.6.1 snapshot"})
    const round = firstRound(result)
    const played = must(round.playedRound, "the fixture's first round")

    // slice(1) for the same reason the parser does it: cells opens with the square the seat was already
    // standing on, and Tapoo does not count that as visited.
    const walked = new Set(played.turns.flatMap((turn) => turn.cells.slice(1)))

    expect(played.outcome?.playerUniqueCellsVisited).toBe(69)
    expect(walked.size).toBe(69)
    // And the figure the card shows is that same count, whichever source it came from.
    expect(must(played.agents[0], "the round's only seat").uniqueCells).toBe(69)

    // And the radius the round was actually configured with, read from the same export.
    const model = must(mazeReplayModel(round.playedRound), "a model for the round")
    expect(value(mazeLevelRows(model), "History window")).toBe("4 cells (Manhattan radius)")
  })

  // The same check against the parser's own counting, on the round that has no outcome to copy from: an
  // unfinished round leaves agentsFromRound's count standing, so this is where a start square counted as
  // entered, or a re-entered cell counted twice, shows up as a number that disagrees with the walk.
  it("counts a seat's cells off its own turns where no outcome settles them", () => {
    const sliced = expectOk(sliceLogText(JSON.stringify(fixtureData), {label: "v2.6.1 snapshot"}))
    const played = must(roundReportFor(at(sliced.rounds, 1)).report.playedRound, "the fixture's second round")
    const azula = must(played.agents[0], "the round's only seat")

    // No outcome record at all, so nothing to copy: this is the parser's arithmetic on its own.
    expect(played.outcome).toBeNull()
    expect(azula.uniqueCells).toBe(new Set(played.turns.flatMap((turn) => turn.cells.slice(1))).size)
    expect(azula.uniqueCells).toBe(15)
    // And every entry, counting a cell again each time it was re-entered - four more than the cells reached.
    expect(azula.cellsEntered).toBe(19)
  })

  // What a finished run spent, over every turn it played, including the batch that finished it.
  //
  // The capture's won round reports its turns one at a time and then stops: a turn's outcome reaches the
  // log through the next turn's tool calls, and the turn that wins has no next turn. Its three-move
  // winning batch is recovered by replaying the submitted moves against the finishing cell, and without
  // that the run is short by exactly the batch that made it a win.
  //
  // 69 rather than the 66 the outcome readings add up to, because one of them is stale: the reading
  // covering turn 47 states no applied move and no charge, while the decay budget it reports falls from
  // 23 to 22 and the player's cell moves from 6,6 to 6,7. The move happened; the record of it did not
  // arrive. The parser reads that turn from its own prediction instead, which is what the trusted-record
  // gate in buildPlayedRound is for.
  it("counts every turn it played, and the winning batch the log never reports", () => {
    const sliced = expectOk(sliceLogText(JSON.stringify(fixtureData), {label: "v2.6.1 snapshot"}))
    const round = must(firstRound(sliced).playedRound, "the fixture's first round")
    const kora = must(round.agents[0], "the round's only seat")

    expect(round.outcome?.turnCount).toBe(67)
    expect(must(round.turns.at(-1), "the winning turn").applied).toBe(3)
    expect(kora.played).toEqual({turnsTaken: 67, movesApplied: 69, movesUnreported: 0})
    // Nothing went unreported, so the figure is a total rather than a floor.
    expect(kora.played?.movesUnreported).toBe(0)
  })

  // The budget the round actually spent, turn by turn, as the log itself reports it.
  //
  // Read rather than derived: the maze holds 70 cells and the first reading says 70 units, so subtracting
  // charges would look equivalent - until a charge goes missing, which is exactly what happens on turn 47.
  // That reading states a charge of 0 while the budget it reports falls from 23 to 22, so a derived series
  // would run one unit high from there to the end of the round.
  it("carries the decay budget each turn reported", () => {
    const sliced = expectOk(sliceLogText(JSON.stringify(fixtureData), {label: "v2.6.1 snapshot"}))
    const round = must(firstRound(sliced).playedRound, "the fixture's first round")
    const remaining = (turn: number) =>
      must(round.turns.find((one) => one.turn === turn), `turn ${turn}`).decayRemaining

    expect(remaining(0)).toBe(69)
    expect(remaining(46)).toBe(23)
    expect(remaining(47)).toBe(22)
    expect(remaining(65)).toBe(4)
    // And null on the turn that won: a turn's budget is reported by the turn after it, and the turn that
    // wins has none. Carrying the last figure forward would state a budget nothing measured.
    expect(remaining(66)).toBeNull()
  })

  // The route the round was measured against, and how much of it the round covered.
  //
  // The capture's maze is one long corridor - its route runs through all 70 cells - so the coverage
  // figure and a cells-over-area figure agree here. They part on a branching maze, which is why the row
  // counts route cells: an area figure is bounded by how many dead ends a maze happens to have.
  it("measures coverage against the route rather than the maze's area", () => {
    const sliced = expectOk(sliceLogText(JSON.stringify(fixtureData), {label: "v2.6.1 snapshot"}))
    const won = must(mazeReplayModel(must(firstRound(sliced).playedRound, "the won round")), "a model")
    const stopped = must(
      mazeReplayModel(must(roundReportFor(at(sliced.rounds, 1)).report.playedRound, "the stopped round")),
      "a model",
    )

    expect(routeCells(won)).toHaveLength(70)
    expect(value(mazeSurvivalRows(won), "Route coverage")).toBe("70 of 70 route cells (100%)")
    // The round that was cut off had entered under a quarter of it.
    expect(value(mazeSurvivalRows(stopped), "Route coverage")).toBe("16 of 70 route cells (23%)")
  })

  it("measures no coverage where the round stated no destination", () => {
    const model = must(mazeReplayModel({...level(), destinationCell: null}), "a model")

    expect(routeCells(model)).toBeNull()
    expect(value(mazeSurvivalRows(model), "Route coverage")).toBe("not recorded")
  })

  // What the won round spent, in the unit it was scored in: every turn cost one unit, so it paid nothing
  // for errors, and the two moves it earned by batching are what carried it past the maze's own size.
  it("splits the won round's spending into the terms that caused it", () => {
    const sliced = expectOk(sliceLogText(JSON.stringify(fixtureData), {label: "v2.6.1 snapshot"}))
    const model = must(mazeReplayModel(must(firstRound(sliced).playedRound, "the won round")), "a model")

    expect(survivalLedgerFor(model)).toMatchObject({errorDebt: 0, routeSlack: 1, batchCredit: 2, headroom: 3})
    // It needed less than a move a turn and managed slightly more.
    expect(survivalLedgerFor(model)!.neededDepth).toBeCloseTo(69 / 70, 12)
    expect(survivalLedgerFor(model)!.batchDepth).toBeCloseTo(69 / 67, 12)
  })

  // A run that finished is never flagged, and a run that was cut off short of the target is not thereby
  // a run that could not finish: the warnings fire, the verdict does not.
  it("flags nothing on the won round, and warns without a verdict on the stopped one", () => {
    const sliced = expectOk(sliceLogText(JSON.stringify(fixtureData), {label: "v2.6.1 snapshot"}))
    const won = must(survivalOutlookFor(mazeReplayModel(must(firstRound(sliced).playedRound, "the won round"))), "an outlook")
    const stopped = must(
      survivalOutlookFor(mazeReplayModel(must(roundReportFor(at(sliced.rounds, 1)).report.playedRound, "the stopped round"))),
      "an outlook",
    )

    expect(won).toMatchObject({lostFrom: null, behindObservedPaceFrom: null, beyondDecayLeftFrom: null, visitedRouteCells: 70})
    // It had budget left when the provider failed, so nothing says it could not have finished.
    expect(stopped.lostFrom).toBeNull()
    expect(stopped.beyondDecayLeftFrom).toBe(1)
    // And the two turns the maze refused a move on, which no status label reports as such.
    expect(stopped.wallContacts).toBe(2)
  })

  // Three readings the capture cannot separate, because its route runs through every cell of a corridor
  // maze and one seat played the whole of it. These use the 6x4 maze, whose route is 18 of its 24 cells.
  describe("on a maze whose route is not the whole of it", () => {
    const turnOf = (over: Partial<TurnSummary> & {turn: number}): TurnSummary => ({
      seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"] as Move[], submittedCount: 1,
      applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, traversalSpeed: null, decayCharged: 1,
      decayRemaining: null, score: null, ...over,
    })

    // Coverage counts the cells of the route, not the cells walked: a round that wandered off it covers
    // less of the route than it entered cells.
    it("counts only the cells of the route, not every cell walked", () => {
      const route = must(routeCells(must(mazeReplayModel(level()), "a model")), "a route")
      const offRoute = must(
        [...Array(24).keys()].map((index) => `${Math.floor(index / 6)},${index % 6}`).find((cell) => !route.includes(cell)),
        "a cell off the route",
      )
      const model = must(mazeReplayModel(level({turns: [
        turnOf({turn: 0, cells: [route[0]!, route[1]!]}),
        turnOf({turn: 1, cells: [route[1]!, offRoute]}),
      ]})), "a model")

      // Three cells walked, two of them on the route.
      expect(value(mazeSurvivalRows(model), "Route coverage")).toBe(`2 of ${route.length} route cells (11%)`)
    })

    // Two seats, one maze, one account. The budget is the maze's and the route is covered by whoever walks
    // it, so a second seat continues the first's run rather than starting a run of its own - and the ledger
    // adds what both were charged against the one budget they drew it from.
    it("reads every seat's turns as one run against the maze", () => {
      const model = must(mazeReplayModel(level({turns: [
        turnOf({turn: 0, playerName: "Katara", cells: ["0,0", "1,0"]}),
        turnOf({turn: 1, playerName: "Bumi", before: "1,0", cells: ["1,0", "2,0"]}),
      ]})), "a model")

      expect(model.agents.map((agent) => agent.name)).toEqual(["Katara", "Bumi"])
      const outlook = must(survivalOutlookFor(model), "the round's outlook")
      expect(outlook.series.map((one) => one.turn)).toEqual([0, 1])
      // Three cells between them, all on the route, and neither seat counted twice.
      expect(outlook.visitedRouteCells).toBe(3)
      expect(survivalLedgerFor(model)).toMatchObject({errorDebt: 0, batchCredit: 0})
      expect(roundPlayed(model)).toEqual({turnsTaken: 2, movesApplied: 2, movesUnreported: 0})
    })

    // A wall is a move the maze refused. A command it could not read is the model spelling a move wrong,
    // which the rubric reports against the prediction - and a turn that applied everything readable hit
    // no wall, however many unreadable commands trailed it.
    it("does not read an unreadable command as a wall", () => {
      const model = must(mazeReplayModel(level({turns: [
        turnOf({turn: 0, moves: ["MoveDown"] as Move[], submittedCount: 3, applied: 1}),
        turnOf({turn: 1, before: "1,0", moves: ["MoveDown", "MoveUp"] as Move[], submittedCount: 2, applied: 1, cells: ["1,0", "2,0"]}),
      ]})), "a model")

      expect(must(survivalOutlookFor(model), "an outlook").series.map((one) => one.wallContact)).toEqual([false, true])
    })
  })

  // The identity, per seat, on the one round where every count is the real parser's: a speed is
  // uniqueCells/decayCharged, and that is the product of the three factors the card prints. Asserted
  // against Tapoo's own stated speed rather than against our ratio, so a parser that miscounted applied
  // moves or turns cannot satisfy it by miscounting both halves the same way.
  it("decomposes the capture's speed into factors that multiply back to it", () => {
    const result = sliceLogText(JSON.stringify(fixtureData), {label: "gemma4"})
    const played = must(firstRound(result).playedRound, "the fixture's first round")
    const katara = must(played.agents[0], "the round's only seat")
    const factors = must(decomposeTraversalSpeed(katara), "the seat's factors")

    // The turns that settled both counts, and the charge over them.
    expect(katara.settled).toEqual({uniqueCells: 69, movesApplied: 69, turnsTaken: 67})
    expect(katara.decayCharged).toBe(67)

    expect(factors.efficiency * factors.batching * factors.accuracy).toBeCloseTo(1.0299, 3)
    expect(Number(played.outcome?.traversalSpeed)).toBe(1.0299)
  })

  // Every entry, against the unique count beside it: the gap between them is the retracing, and it is the
  // only place on the card that says how much of the walk was ground the seat had already covered.
  it("counts a cell again each time the seat came back to it", () => {
    const there = ["1,0", "2,0"] as CellKey[]
    const back = ["2,0", "1,0"] as CellKey[]
    const turns: TurnSummary[] = [
      {...must(DEFAULT_TURNS[0], "a turn"), turn: 0, before: "1,0", applied: 1, cells: there, decayCharged: 1, decayRemaining: null},
      {...must(DEFAULT_TURNS[0], "a turn"), turn: 1, before: "2,0", applied: 1, cells: back, decayCharged: 1, decayRemaining: null},
    ]
    const seat = must(agentsFromRound(new Map(), turns, null)[0], "the round's only seat")

    // Two entries over two turns, into one cell each way - and only two cells between them.
    expect(seat.cellsEntered).toBe(2)
    expect(seat.uniqueCells).toBe(2)

    // And the same seat again, having walked back into "1,0" a second time: three entries, still two cells.
    const retraced = must(agentsFromRound(new Map(), [...turns, {...must(turns[0], "a turn"), turn: 2}], null)[0], "the seat")
    expect(retraced.cellsEntered).toBe(3)
    expect(retraced.uniqueCells).toBe(2)
  })

  // Within one turn too, not only between turns: a batch can walk back over itself - three moves that leave
  // and return and leave again are three entries into two cells.
  it("counts a cell again where one turn re-enters it", () => {
    const oscillating: TurnSummary[] = [{
      ...must(DEFAULT_TURNS[0], "a turn"), applied: 3,
      cells: ["0,0", "1,0", "0,0", "1,0"] as CellKey[], decayCharged: 1, decayRemaining: null,
    }]
    const seat = must(agentsFromRound(new Map(), oscillating, null)[0], "the round's only seat")

    expect(seat.cellsEntered).toBe(3)
    expect(seat.uniqueCells).toBe(2)
  })

  // A seat that took its turn and moved nowhere counts no entry, which is a measurement rather than an
  // absence: "not recorded" is for a seat with no turns at all.
  it("counts no entry for a turn that moved nowhere", () => {
    const stayed: TurnSummary[] = [{...must(DEFAULT_TURNS[0], "a turn"), applied: 0, cells: ["0,0"], decayCharged: 3, decayRemaining: null}]
    const seat = must(agentsFromRound(new Map(), stayed, null)[0], "the round's only seat")

    expect(seat.cellsEntered).toBe(0)
  })

  // The defect the `settled` counts exist for, at the shape every round has: Tapoo reports a turn's charge
  // on the turn after it, so the last turn of a round states none. Counting that turn's moves while leaving
  // its charge out of the total made turns exceed charges - 48 against 47 - and printed an accuracy of
  // 1.0213, which is not a value a share of turns can take.
  //
  // Asserted as the ceiling rather than as the number, because the ceiling is the property: no turn is
  // charged less than one unit, so accuracy is at most 1 on every log, and a decomposition that can exceed
  // it is dividing two different populations again.
  it("keeps accuracy at its ceiling when the last turn was never charged", () => {
    const turns: TurnSummary[] = Array.from({length: 48}, (_, index) => ({
      turn: index, seatId: null, playerName: "Kora", before: `${index},0`,
      moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1,
      cells: [`${index},0`, `${index + 1},0`] as CellKey[], rejectedMove: null,
      traversalSpeed: 1, decayCharged: index === 47 ? null : 1, decayRemaining: null, score: null,
    }))
    const kora = must(agentsFromRound(new Map(), turns, null)[0], "the round's only seat")
    const factors = must(decomposeTraversalSpeed(kora), "the seat's factors")

    // The turn with no charge is out of all three counts, not just the charge.
    expect(kora.settled).toEqual({uniqueCells: 47, movesApplied: 47, turnsTaken: 47})
    // While the seat's own count still covers every turn it played, reconciling with what Tapoo reports.
    expect(kora.uniqueCells).toBe(48)

    expect(factors.accuracy).toBeLessThanOrEqual(1)
    expect(factors.efficiency).toBeLessThanOrEqual(1)
    expect(factors.efficiency * factors.batching * factors.accuracy).toBeCloseTo(1, 12)
  })

  // A seat the round stated no charge for has no accuracy, so it has no decomposition at all - the card
  // says "not recorded" rather than printing two of three factors as though the third were 1.
  it("decomposes nothing for a seat the round did not charge", () => {
    const [katara] = seatsOf()

    expect(katara?.decayCharged).toBeNull()
    expect(decomposeTraversalSpeed(must(katara, "the round's only seat"))).toBeNull()
  })

  it("reports no decay when turns carry no charge", () => {
    // The test fixture has decayCharged: null on every turn.
    expect(seatsOf()[0]?.decayCharged).toBeNull()
  })

  it("accumulates per-turn decay per agent", () => {
    const seats = seatsOf({
      turns: [
        { turn: 0, seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, traversalSpeed: null, decayCharged: 1, decayRemaining: null , score: null},
        { turn: 1, seatId: null, playerName: "Katara", before: "1,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, traversalSpeed: null, decayCharged: 2, decayRemaining: null , score: null},
      ],
    })

    expect(seats[0]?.decayCharged).toBe(3)
  })

  it("tracks each agent's speed, decay, and cells separately in a multi-agent level", () => {
    const seats = seatsOf({
      turns: [
        { turn: 0, seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, traversalSpeed: null, decayCharged: 1, decayRemaining: null , score: null},
        { turn: 1, seatId: null, playerName: "Bumi", before: "1,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, traversalSpeed: null, decayCharged: 2, decayRemaining: null , score: null},
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
      { turn: 0, seatId: null, playerName: null, before: "0,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, traversalSpeed: null, decayCharged: null, decayRemaining: null , score: null},
    ]

    expect(seatsOf({turns: anonymous})).toEqual([])
  })
})
