import {describe, expect, it} from "vitest"

import fixtureData from "./_snapshot_/tapoo-v2.5.1-gemma4-base-agent-api-log.json" with {type: "json"}
import {LOG_EVENTS} from "./log-events"
import {buildLevels, gameIdentityKey, resolveActiveAgentNames} from "./rounds"
import {buildContext} from "./rubric-engine"
import {buildReport} from "./rubric-report"
import {at, levelOf as firstLevel, must, rubricTurn as turn, toolMessage} from "./test-support"
import type {Level, LogEntry, LogLevel} from "./types"

const entry = (
  payload: string,
  details: unknown,
  {turn = 0, game, level, log = "info"}:
    {turn?: number; game?: number; level?: number; log?: LogLevel} = {},
): LogEntry =>
  ({epochMs: 1788000000000 + turn, time: "t", turn, level, game, log, payload, details})

const REAL_MAZE = {
  index_chars: ["|", "---", "-", "   ", " ", "\n"],
  structure_checksum: "0x74af82cb14470b9d",
  structure:
    "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
  dimensions: {numCols: 6, numRows: 4, area: 24},
}

const prediction = (moves: string[], turn: number, round: {game?: number; level?: number} = {}) =>
  entry(LOG_EVENTS.response, {payload: {message: {content: JSON.stringify({moves})}}}, {turn, ...round})

// Every per-seat figure is joined by the name this returns, and a turn it cannot attribute is a turn whose
// charge, cells and setup belong to nobody - reported as a round with fewer agents than it had, with
// nothing on the page saying so. Tested directly for that reason: the failure leaves no trace to assert on
// further downstream.
// Every per-seat figure is joined by the name this returns, and a turn it cannot attribute is a turn whose
// charge, cells and setup belong to nobody - reported as a round with fewer agents than it had, with
// nothing on the page saying so. Tested directly for that reason: the failure leaves no trace to assert on
// further downstream.
describe("resolveActiveAgentNames", () => {
  const request = (turn: number, details: Record<string, unknown>) =>
    entry(LOG_EVENTS.request, details, {turn})
  const names = (entries: LogEntry[]) => [...resolveActiveAgentNames(entries)]

  // Two sources, and this is the order. A name stated about the turn itself outranks the label, so the
  // label here is wrong and ignored.
  it("takes the name the request states over the label", () => {
    expect(names([request(0, {playerName: "Katara", player: "Bumi the Navigator - 1.0000x"})]))
      .toEqual([[0, "Katara"]])
  })

  // The label alone is enough, whatever else the log does or does not say. Nothing is harvested from the
  // round-end records or the tool results to make this work.
  it("reads the player out of the label, with no other entry in the log", () => {
    expect(names([request(0, {player: "Katara the Trailblazer - Default"})])).toEqual([[0, "Katara"]])
    expect(names([request(0, {player: "Momo the Backtracker - 0.4360x"})])).toEqual([[0, "Momo"]])
    expect(names([request(0, {player: "Aang the Navigator - 1.0000x"})])).toEqual([[0, "Aang"]])
  })

  // The case a split on " the " gets wrong: a name may contain the phrase and still fit in eight characters,
  // and this reads it whole rather than cutting at the first occurrence.
  it("reads a name that itself contains the phrase the label separates on", () => {
    expect(names([request(0, {player: "A the B the Navigator - 0.5000x"})])).toEqual([[0, "A the B"]])
  })

  // A name is 3 to 8 characters, so a longer or shorter run in that position is not one. Checking it is
  // what makes this a parse: without the bound, "Self-taught the Navigator - 1.0x" reports a player.
  it("rejects a label whose name is outside the length a name can be", () => {
    expect(names([request(0, {player: "Self-taught the Navigator - 1.0000x"})])).toEqual([])
    expect(names([request(0, {player: "Ka the Navigator - 1.0000x"})])).toEqual([])
  })

  // The personas are stated, so a fourth stops resolving rather than resolving to something wrong. It shows
  // as a seat missing from the round, which is the failure to watch for if Tapoo adds one.
  it("rejects a label naming a persona this does not know", () => {
    expect(names([request(0, {player: "Katara the Wayfinder - 1.0000x"})])).toEqual([])
  })

  // The shape is the whole of it: a bare name is not a label, and neither is a label missing its speed.
  it("rejects anything that is not the label's shape", () => {
    expect(names([request(0, {player: "Katara"})])).toEqual([])
    expect(names([request(0, {player: "Katara the Navigator"})])).toEqual([])
    expect(names([request(0, {player: ""})])).toEqual([])
  })

  // One turn, one seat. A retry of a turn is that seat asking again, so the first request answers for it and
  // a later one cannot move the turn to somebody else.
  it("keeps the first request's answer for a turn that was retried", () => {
    expect(names([request(0, {playerName: "Katara"}), request(0, {playerName: "Bumi"})]))
      .toEqual([[0, "Katara"]])
  })

  // Only requests attribute a turn. A round-end record names whoever finished rather than whoever played
  // the turn it sits on, and reading it here would give a two-seat round one player.
  it("reads only requests", () => {
    expect(names([
      entry(LOG_EVENTS.response, {payload: {message: {content: "{}"}}}, {turn: 0}),
      entry(LOG_EVENTS.levelWon, {outcome: "won", agent: {playerName: "Katara"}}, {turn: 1}),
    ])).toEqual([])
  })
})

describe("which round an entry belongs to", () => {
  // The bug this exists for: `entry.game ?? 0` was read per entry, so an entry that did not name its
  // round was filed under a fabricated round "?/?" rather than the one in progress. On a log that
  // stamps game and level only on its round boundaries - which is most of a large log - that split one
  // real round in two: a round with the encoded maze and no turns, and a phantom round with every turn
  // and no maze.
  //
  // What the reader saw was a maze replay whose scrubber ran 0 to 0 and a Turns column reading zero, on
  // a log with hundreds of turns.
  const roundMarkersOnly: LogEntry[] = [
    entry(LOG_EVENTS.levelStarted, {maze: REAL_MAZE, startPosition: {x: 1, y: 1}, destinationCell: [0, 5]},
      {turn: 0, game: 6, level: 54}),
    prediction(["MoveDown"], 0),
    prediction(["MoveDown"], 1),
    prediction(["MoveRight"], 2),
    entry(LOG_EVENTS.levelWon, {outcome: "won"}, {turn: 2, game: 6, level: 54}),
  ]

  it("keeps a round whole when only its boundaries name it", () => {
    const levels = buildLevels(roundMarkersOnly)

    expect(levels).toHaveLength(1)
    expect(gameIdentityKey(at(levels, 0).identity)).toBe("6/54")
  })

  it("gives that round both its maze and its turns, not one each", () => {
    const level = at(buildLevels(roundMarkersOnly), 0)

    // The pairing is the whole point: a round with a maze and no turns cannot be replayed, and a round
    // with turns and no maze has nothing to draw them on.
    expect(level.encodedMaze).not.toBeNull()
    expect(level.turns).toHaveLength(3)
  })

  it("invents no round that the log never recorded", () => {
    expect(buildLevels(roundMarkersOnly).map((level) => gameIdentityKey(level.identity))).not.toContain("?/?")
  })

  it("separates two rounds that each name themselves", () => {
    const levels = buildLevels([
      entry(LOG_EVENTS.levelStarted, {maze: REAL_MAZE}, {turn: 0, game: 6, level: 54}),
      prediction(["MoveDown"], 0),
      entry(LOG_EVENTS.levelStarted, {maze: REAL_MAZE}, {turn: 1, game: 6, level: 55}),
      prediction(["MoveUp"], 1),
    ])

    expect(levels.map((level) => gameIdentityKey(level.identity))).toEqual(["6/54", "6/55"])
    expect(levels.every((level) => level.turns.length === 1)).toBe(true)
  })

  it("attaches a preamble to the round that opens after it", () => {
    // Entries before the first round marker cannot belong to an earlier round, because there is none.
    const levels = buildLevels([
      prediction(["MoveDown"], 0),
      entry(LOG_EVENTS.levelStarted, {maze: REAL_MAZE}, {turn: 1, game: 6, level: 54}),
      prediction(["MoveUp"], 1),
    ])

    expect(levels).toHaveLength(1)
    expect(at(levels, 0).turns).toHaveLength(2)
  })

  it("treats a log that names no round at all as one round", () => {
    const levels = buildLevels([prediction(["MoveDown"], 0), prediction(["MoveUp"], 1)])

    expect(levels).toHaveLength(1)
    expect(at(levels, 0).turns).toHaveLength(2)
  })
})

describe("reading a turn from the outcome Tapoo reported", () => {
  // Tapoo reports each turn's outcome to the turn *after* it, and that record states where replay
  // began and which move was the last to land. Inferring both instead means keying the same payload by its
  // move list, and a move list is not unique to a turn: in a real 464-turn log, 502 readings collapse onto
  // 86 sequences, 30 of them seen with different applied indexes, which puts another turn's path on 63 of
  // them.
  const outcomeTool = (turn: number, body: Record<string, unknown>) =>
    entry(LOG_EVENTS.request, {
      messages: [{role: "tool", tool_name: "get_last_prediction_outcome",
        content: JSON.stringify({lastMoveStatus: "applied", ...body})}],
      tools: [],
    }, {turn, game: 6, level: 54})

  const round = (...rest: LogEntry[]): LogEntry[] => [
    entry(LOG_EVENTS.levelStarted, {maze: REAL_MAZE, startPosition: {x: 1, y: 1}}, {turn: 0, game: 6, level: 54}),
    ...rest,
  ]

  it("takes the path from the record rather than inferring it", () => {
    // Two turns submit the identical batch and end differently. Keyed by moves, the second overwrites
    // the first; keyed by reporting turn, each keeps its own.
    const levels = buildLevels(round(
      prediction(["MoveDown", "MoveDown"], 0, {game: 6, level: 54}),
      outcomeTool(1, {lastReplayStartCell: {row: 0, col: 0}, lastSubmittedMoves: ["MoveDown", "MoveDown"],
        lastAppliedMoveIndex: 1, chargedMovesCount: 2}),
      prediction(["MoveDown", "MoveDown"], 1, {game: 6, level: 54}),
      outcomeTool(2, {lastReplayStartCell: {row: 2, col: 0}, lastSubmittedMoves: ["MoveDown", "MoveDown"],
        lastAppliedMoveIndex: 0, chargedMovesCount: 1}),
      entry(LOG_EVENTS.levelWon, {outcome: "won", turnCount: 2, decayUnitsCharged: 4,
        playerPosition: {x: 1, y: 7}}, {turn: 1, game: 6, level: 54}),
    ))
    const turns = at(levels, 0).turns

    expect(at(turns, 0)).toMatchObject({before: "0,0", applied: 2, cells: ["0,0", "1,0", "2,0"]})
    expect(at(turns, 1)).toMatchObject({before: "2,0", applied: 1, cells: ["2,0", "3,0"]})
  })

  it("attributes the record to the turn before the one that read it", () => {
    const levels = buildLevels(round(
      prediction(["MoveDown"], 0, {game: 6, level: 54}),
      outcomeTool(1, {lastReplayStartCell: {row: 0, col: 0}, lastSubmittedMoves: ["MoveDown"],
        lastAppliedMoveIndex: 0, chargedMovesCount: 3}),
    ))

    expect(at(at(levels, 0).turns, 0).decayCharged).toBe(3)
  })

  it("names the refused move from the record's applied index", () => {
    const levels = buildLevels(round(
      prediction(["MoveDown", "MoveUp"], 0, {game: 6, level: 54}),
      outcomeTool(1, {lastReplayStartCell: {row: 0, col: 0}, lastSubmittedMoves: ["MoveDown", "MoveUp"],
        lastAppliedMoveIndex: 0, chargedMovesCount: 2}),
    ))

    expect(at(at(levels, 0).turns, 0)).toMatchObject({applied: 1, rejectedMove: "MoveUp"})
  })

  it("falls back to the derivation when the record describes a different prediction", () => {
    // A wrong path drawn confidently is worse than a derived one, so a record whose moves do not match
    // this turn's is not trusted at all.
    const levels = buildLevels(round(
      prediction(["MoveDown"], 0, {game: 6, level: 54}),
      outcomeTool(1, {lastReplayStartCell: {row: 9, col: 9}, lastSubmittedMoves: ["MoveLeft", "MoveLeft"],
        lastAppliedMoveIndex: 1, chargedMovesCount: 7}),
    ))
    const turn = at(at(levels, 0).turns, 0)

    expect(turn.before).not.toBe("9,9")
    expect(turn.decayCharged).toBeNull()
  })

  it("does not borrow a later matching record when the next turn did not report", () => {
    const levels = buildLevels(round(
      prediction(["MoveDown"], 0, {game: 6, level: 54}),
      prediction(["MoveDown"], 1, {game: 6, level: 54}),
      outcomeTool(2, {lastReplayStartCell: {row: 5, col: 5}, lastSubmittedMoves: ["MoveDown"],
        lastAppliedMoveIndex: 0, chargedMovesCount: 2}),
    ))
    const turns = at(levels, 0).turns

    expect(at(turns, 0)).toMatchObject({before: null, cells: [], decayCharged: null})
    expect(at(turns, 0).before).not.toBe("5,5")
    expect(at(turns, 1)).toMatchObject({before: "5,5", applied: 1, cells: ["5,5", "6,5"], decayCharged: 2})
  })

  it("settles the closing turn's charge from the round total", () => {
    // No turn follows the last one to report it, so the total settles it - and the subtraction covers
    // every reading, not only those that reached a turn, or a turn that made no prediction would hand
    // its cost to the closing turn.
    const levels = buildLevels(round(
      // Turn 0 reads the placeholder before it predicts, the way every real turn does - which is what
      // makes the reading count match the round's own turnCount.
      outcomeTool(0, {lastMoveStatus: null, lastSubmittedMoves: [], chargedMovesCount: 0}),
      prediction(["MoveDown"], 0, {game: 6, level: 54}),
      outcomeTool(1, {lastReplayStartCell: {row: 0, col: 0}, lastSubmittedMoves: ["MoveDown"],
        lastAppliedMoveIndex: 0, chargedMovesCount: 1}),
      prediction(["MoveDown"], 1, {game: 6, level: 54}),
      entry(LOG_EVENTS.levelWon, {outcome: "won", turnCount: 2, decayUnitsCharged: 5,
        playerPosition: {x: 1, y: 5}}, {turn: 1, game: 6, level: 54}),
    ))
    const turns = at(levels, 0).turns

    // Two readings for a two-turn round, so the remainder is the closing turn's alone.
    expect(at(turns, 0).decayCharged).toBe(1)
    expect(at(turns, 1).decayCharged).toBe(4)
  })

  it("leaves the closing charge unknown when a turn never reported", () => {
    // turnCount says three turns; only one reading exists, so the remainder would absorb the missing
    // turns' cost and attribute all of it to the last one.
    const levels = buildLevels(round(
      prediction(["MoveDown"], 0, {game: 6, level: 54}),
      outcomeTool(1, {lastReplayStartCell: {row: 0, col: 0}, lastSubmittedMoves: ["MoveDown"],
        lastAppliedMoveIndex: 0, chargedMovesCount: 1}),
      prediction(["MoveDown"], 1, {game: 6, level: 54}),
      entry(LOG_EVENTS.levelWon, {outcome: "won", turnCount: 3, decayUnitsCharged: 9,
        playerPosition: {x: 1, y: 5}}, {turn: 1, game: 6, level: 54}),
    ))

    expect(at(at(levels, 0).turns, 1).decayCharged).toBeNull()
  })
})

describe("a turn that produced no prediction", () => {
  // A malformed response, an exhausted token cap, or a failed request leaves no moves to replay, so
  // nothing becomes a submission - so without this the turn is absent from the replay while Tapoo still
  // counts it and still charges three units for it, its heaviest penalty. On one real log that is 464 turns
  // reported against Tapoo's own 473, and a decay strip that can never reach the round total because its
  // most expensive turns are the missing ones.
  const outcomeTool = (turn: number, body: Record<string, unknown>) =>
    entry(LOG_EVENTS.request, {
      messages: [{role: "tool", tool_name: "get_last_prediction_outcome",
        content: JSON.stringify({lastMoveStatus: "applied", ...body})}],
      tools: [],
    }, {turn, game: 6, level: 54})

  const roundWithEmptyTurn = () => buildLevels([
    entry(LOG_EVENTS.levelStarted, {maze: REAL_MAZE, startPosition: {x: 1, y: 1}}, {turn: 0, game: 6, level: 54}),
    outcomeTool(0, {lastMoveStatus: null, lastSubmittedMoves: [], chargedMovesCount: 0}),
    prediction(["MoveDown"], 0, {game: 6, level: 54}),
    outcomeTool(1, {lastReplayStartCell: {row: 0, col: 0}, lastSubmittedMoves: ["MoveDown"],
      lastAppliedMoveIndex: 0, chargedMovesCount: 1, predictionStatus: "all-applied"}),
    // Turn 1 answers with something unusable - no prediction is parsed, so no submission exists.
    outcomeTool(2, {lastMoveStatus: "malformed-response", predictionStatus: "empty-prediction",
      lastSubmittedMoves: [], lastAppliedMoveIndex: null, chargedMovesCount: 3}),
    prediction(["MoveDown"], 2, {game: 6, level: 54}),
    outcomeTool(3, {lastReplayStartCell: {row: 1, col: 0}, lastSubmittedMoves: ["MoveDown"],
      lastAppliedMoveIndex: 0, chargedMovesCount: 1, predictionStatus: "all-applied"}),
  ])

  it("is a turn in the replay, even with nothing to replay", () => {
    expect(roundWithEmptyTurn()[0]?.turns.map((turn) => turn.turn)).toEqual([0, 1, 2])
  })

  it("carries the charge Tapoo levied for it", () => {
    expect(at(roundWithEmptyTurn()[0]!.turns, 1)).toMatchObject({moves: [], applied: 0, decayCharged: 3})
  })

  it("leaves the agent where the turn before it ended", () => {
    // Without this the scrubber snaps the agent back to the start whenever a turn submitted nothing.
    const empty = at(roundWithEmptyTurn()[0]!.turns, 1)

    expect(empty.before).toBe("1,0")
    expect(empty.cells).toEqual(["1,0"])
  })

  it("does not count as a prediction", () => {
    // report.predictions counts submissions; turns counts turns. The two differ by exactly these.
    const turns = roundWithEmptyTurn()[0]!.turns

    expect(turns.filter((turn) => turn.moves.length > 0)).toHaveLength(2)
    expect(turns).toHaveLength(3)
  })
})

// --- Levels, built from a round's entries ---

describe("a round's identity on a log that labels only its boundaries", () => {
  it("takes game and level from the round, not from the entry that opens it", () => {
    const entries = [
      {epochMs: 1, log: "info", payload: LOG_EVENTS.request, details: {}},
      {epochMs: 2, log: "info", payload: LOG_EVENTS.levelStarted, details: {}, game: 7, level: 3, turn: 0},
      {epochMs: 3, log: "info", payload: LOG_EVENTS.request, details: {}, turn: 1},
    ] as unknown as LogEntry[]

    const level = must(buildLevels(entries)[0], "a level")

    expect(level.identity).toEqual({game: 7, level: 3})
    expect(gameIdentityKey(level.identity)).toBe("7/3")
    // The entry the group opens with says neither, which is the whole point.
    expect(entries[0]).not.toHaveProperty("game")
  })
})

describe("buildLevels reusing the caller's context", () => {
  // A Level carries Maps and a TurnReports whose members are closures, so toEqual on the record itself
  // compares function identity and fails on two runs that agree completely. Projected to data instead.
  const shape = (levels: Level[]) =>
    levels.map((level) => ({
      ...level,
      observedExits: [...level.observedExits].map(([cell, moves]) => [cell, [...moves].sort()]),
      visitStatusAfterTurn: level.visitStatusAfterTurn
        .ascending()
        .map(([turn, cells]) => [turn, [...cells]]),
    }))

  it("produces the same levels whether or not it is given one", () => {
    const entries = fixtureData.entries as LogEntry[]
    const context = buildContext(entries, {label: "fixture"})

    expect(shape(buildLevels(entries, context))).toEqual(shape(buildLevels(entries)))
  })

  // The reuse is refused when the entries hold more than one round: the caller's context spans all of
  // them, and a level built from it would carry another maze's positions and exits.
  it("ignores a context that spans more than one round", () => {
    // Each round submits its own move, so a context spanning both would give round 1 round 2's turn -
    // exactly the leak buildLevels exists to prevent. With one submission each, a spanning context
    // hands every level two turns instead of one.
    // Written out rather than through `entry` above, which pins level and game to 1.
    let clock = 0
    const at = (game: number, level: number, turn: number, payload: string, details?: unknown): LogEntry =>
      ({epochMs: (clock += 1000), time: "2026-08-31T09-00-00+02-00", level, game, turn, log: "info", payload, details})
    const round = (game: number, level: number, move: string) => [
      at(game, level, 0, LOG_EVENTS.levelStarted, {level}),
      at(game, level, 1, LOG_EVENTS.response, {payload: {message: {content: `{"moves":["${move}"]}`}}}),
    ]
    const twoRounds = [...round(1, 1, "MoveUp"), ...round(1, 2, "MoveDown")]
    const spanning = buildContext(twoRounds, {label: "two"})

    const perRound = shape(buildLevels(twoRounds))
    expect(perRound).toHaveLength(2)
    expect(perRound.map((level) => level.turns.length)).toEqual([1, 1])
    expect(shape(buildLevels(twoRounds, spanning))).toEqual(perRound)
  })
})

describe("buildLevels", () => {
  const round = (game: number, level: number, content: string) => [
    entry(LOG_EVENTS.levelStarted, {startPosition: {x: 1, y: 1}}, {turn: 0}),
    ...turn(0, {tools: ["get_maze_structure"], content}),
  ].map((record) => ({...record, game, level}))

  it("keeps a retry of the same level as its own round", () => {
    // A retry regenerates the maze, so grouping by level alone would merge two different mazes and draw
    // a path crossing walls that exist in neither. Asked of buildLevels rather than of a report: a
    // report answers one round, so it has nowhere to put the second.
    const levels = buildLevels([
      ...round(1, 1, '{"moves":["MoveDown"]}'),
      ...round(2, 1, '{"moves":["MoveUp"]}'),
    ])

    expect(levels.map((level) => gameIdentityKey(level.identity))).toEqual(["1/1", "2/1"])
    expect(at(levels, 0).startCell).toBe("0,0")
  })

  it("attributes a turn to the active agent named in the request", () => {
    const report = buildReport([
      entry(LOG_EVENTS.request, {
        player: "Katara the Trailblazer - Default",
        tools: [{name: "get_maze_structure"}],
        messages: [
          toolMessage({
            currentCell: [0, 0],
            filteredTraversalHistory: [{playerName: "Katara", cell: [0, 0], openMoves: [["MoveDown", "unvisited"]]}],
          }),
        ],
      }, {turn: 0}),
      entry(LOG_EVENTS.response, {payload: {model: "m", message: {content: '{"moves":["MoveDown"]}'}}}, {turn: 0}),
    ])

    expect(firstLevel(report).turns[0]?.playerName).toBe("Katara")
  })

  it("records the refused move of a turn that was cut short", () => {
    const report = buildReport([
      ...turn(0, {
        tools: ["get_maze_structure"],
        messages: [
          toolMessage({
            currentCell: [0, 0],
            filteredTraversalHistory: [{playerName: "K", cell: [0, 0], openMoves: [["MoveDown", "unvisited"]]}],
          }),
        ],
        content: '{"moves":["MoveDown","MoveUp"]}',
      }),
      entry(LOG_EVENTS.request, {
        tools: [{name: "get_last_prediction_outcome"}],
        messages: [
          toolMessage({
            lastMoveStatus: "invalid-move",
            lastSubmittedMoves: ["MoveDown", "MoveUp"],
            lastAppliedMoveIndex: 0,
            chargedMovesCount: 2,
          }),
        ],
      }, {turn: 1}),
    ])

    const first = at(firstLevel(report).turns, 0)
    expect(first.applied).toBe(1)
    expect(first.rejectedMove).toBe("MoveUp")
    expect(first.cells).toEqual(["0,0", "1,0"])
  })
})
