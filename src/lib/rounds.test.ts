import {describe, expect, it} from "vitest"

import fixtureData from "./_snapshot_/tapoo-v2.5.1-gemma4-base-agent-api-log.json" with {type: "json"}
import {LOG_EVENTS} from "./log-events"
import {agentSeatLabel, agentSettingsCheck} from "./log-contract"
import {agentsFromRound, buildPlayedRound, gameIdentityKey, groupEntriesByRound, resolveActiveAgentNames} from "./rounds"
import {buildContext} from "./rubric-context"
import {buildReport} from "./rubric-report"
import {at, levelOf as firstLevel, must, rubricTurn as turn, toolMessage} from "./test-support"
import type {AgentSummary, LogEntry, LogLevel, Move, PlayedRound, RawTurnSetup} from "./types"

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
// Every round in this file is built the way the app builds one: a context over exactly these entries,
// handed to buildPlayedRound. Grouped first where a case holds more than one round, because a context
// describes one.
const playedRound = (entries: LogEntry[]): PlayedRound =>
  must(buildPlayedRound(entries, buildContext(entries, {label: "round"})), "a round")

const playedRounds = (entries: LogEntry[]): PlayedRound[] =>
  groupEntriesByRound(entries).map((group) => playedRound(group.entries))

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
    const levels = playedRounds(roundMarkersOnly)

    expect(levels).toHaveLength(1)
    expect(gameIdentityKey(at(levels, 0).identity)).toBe("6/54")
  })

  it("gives that round both its maze and its turns, not one each", () => {
    const level = playedRound(roundMarkersOnly)

    // The pairing is the whole point: a round with a maze and no turns cannot be replayed, and a round
    // with turns and no maze has nothing to draw them on.
    expect(level.encodedMaze).not.toBeNull()
    expect(level.turns).toHaveLength(3)
  })

  it("invents no round that the log never recorded", () => {
    expect(playedRounds(roundMarkersOnly).map((level) => gameIdentityKey(level.identity))).not.toContain("?/?")
  })

  it("separates two rounds that each name themselves", () => {
    const levels = playedRounds([
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
    const levels = playedRounds([
      prediction(["MoveDown"], 0),
      entry(LOG_EVENTS.levelStarted, {maze: REAL_MAZE}, {turn: 1, game: 6, level: 54}),
      prediction(["MoveUp"], 1),
    ])

    expect(levels).toHaveLength(1)
    expect(at(levels, 0).turns).toHaveLength(2)
  })

  it("treats a log that names no round at all as one round", () => {
    const levels = playedRounds([prediction(["MoveDown"], 0), prediction(["MoveUp"], 1)])

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
    const levels = playedRounds(round(
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
    const levels = playedRounds(round(
      prediction(["MoveDown"], 0, {game: 6, level: 54}),
      outcomeTool(1, {lastReplayStartCell: {row: 0, col: 0}, lastSubmittedMoves: ["MoveDown"],
        lastAppliedMoveIndex: 0, chargedMovesCount: 3}),
    ))

    expect(at(at(levels, 0).turns, 0).decayCharged).toBe(3)
  })

  it("names the refused move from the record's applied index", () => {
    const levels = playedRounds(round(
      prediction(["MoveDown", "MoveUp"], 0, {game: 6, level: 54}),
      outcomeTool(1, {lastReplayStartCell: {row: 0, col: 0}, lastSubmittedMoves: ["MoveDown", "MoveUp"],
        lastAppliedMoveIndex: 0, chargedMovesCount: 2}),
    ))

    expect(at(at(levels, 0).turns, 0)).toMatchObject({applied: 1, rejectedMove: "MoveUp"})
  })

  it("falls back to the derivation when the record describes a different prediction", () => {
    // A wrong path drawn confidently is worse than a derived one, so a record whose moves do not match
    // this turn's is not trusted at all.
    const levels = playedRounds(round(
      prediction(["MoveDown"], 0, {game: 6, level: 54}),
      outcomeTool(1, {lastReplayStartCell: {row: 9, col: 9}, lastSubmittedMoves: ["MoveLeft", "MoveLeft"],
        lastAppliedMoveIndex: 1, chargedMovesCount: 7}),
    ))
    const turn = at(at(levels, 0).turns, 0)

    expect(turn.before).not.toBe("9,9")
    expect(turn.decayCharged).toBeNull()
  })

  it("does not borrow a later matching record when the next turn did not report", () => {
    const levels = playedRounds(round(
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
    const levels = playedRounds(round(
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
    const levels = playedRounds(round(
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
  // nothing becomes a prediction - so without this the turn is absent from the replay while Tapoo still
  // counts it and still charges three units for it, its heaviest penalty. On one real log that is 464 turns
  // reported against Tapoo's own 473, and a decay strip that can never reach the round total because its
  // most expensive turns are the missing ones.
  const outcomeTool = (turn: number, body: Record<string, unknown>) =>
    entry(LOG_EVENTS.request, {
      messages: [{role: "tool", tool_name: "get_last_prediction_outcome",
        content: JSON.stringify({lastMoveStatus: "applied", ...body})}],
      tools: [],
    }, {turn, game: 6, level: 54})

  const roundWithEmptyTurn = () => playedRounds([
    entry(LOG_EVENTS.levelStarted, {maze: REAL_MAZE, startPosition: {x: 1, y: 1}}, {turn: 0, game: 6, level: 54}),
    outcomeTool(0, {lastMoveStatus: null, lastSubmittedMoves: [], chargedMovesCount: 0}),
    prediction(["MoveDown"], 0, {game: 6, level: 54}),
    outcomeTool(1, {lastReplayStartCell: {row: 0, col: 0}, lastSubmittedMoves: ["MoveDown"],
      lastAppliedMoveIndex: 0, chargedMovesCount: 1, predictionStatus: "all-applied"}),
    // Turn 1 answers with something unusable - no prediction is parsed, so nothing is recorded.
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
    expect(at(roundWithEmptyTurn()[0]!.turns, 1)).toMatchObject({moves: [], submittedCount: 0, applied: 0, decayCharged: 3})
  })

  it("leaves the agent where the turn before it ended", () => {
    // Without this the scrubber snaps the agent back to the start whenever a turn submitted nothing.
    const empty = at(roundWithEmptyTurn()[0]!.turns, 1)

    expect(empty.before).toBe("1,0")
    expect(empty.cells).toEqual(["1,0"])
  })

  it("does not count as a prediction", () => {
    // report.predictions counts predictions; turns counts turns. The two differ by exactly these.
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

    const level = playedRound(entries)

    expect(level.identity).toEqual({game: 7, level: 3})
    expect(gameIdentityKey(level.identity)).toBe("7/3")
    // The entry the group opens with says neither, which is the whole point.
    expect(entries[0]).not.toHaveProperty("game")
  })
})

describe("the context buildPlayedRound is handed", () => {
  // A PlayedRound carries Maps and a TurnReports whose members are closures, so toEqual on the record
  // itself compares function identity and fails on two runs that agree completely. Projected to data.
  const shape = (round: PlayedRound) => ({
    ...round,
    observedExits: [...round.observedExits].map(([cell, moves]) => [cell, [...moves].sort()]),
    visitStatusAfterTurn: round.visitStatusAfterTurn.ascending().map(([turn, cells]) => [turn, [...cells]]),
  })

  const roundOf = (entries: LogEntry[]) =>
    must(buildPlayedRound(entries, buildContext(entries, {label: "round"})), "a round")

  // The caller's context, over exactly these entries. buildContext is the most expensive read the app
  // makes, so the record must be derived from the one already built rather than from a second walk.
  it("derives the round from the context it is given", () => {
    const entries = fixtureData.entries as LogEntry[]
    const context = buildContext(entries, {label: "fixture"})

    expect(shape(must(buildPlayedRound(entries, context), "a round"))).toEqual(shape(roundOf(entries)))
  })

  // A context describes one round, so entries holding two are a caller's mistake rather than something
  // to paper over: positions and exits from one maze reaching another is the leak this file exists to
  // prevent, and a round silently built from a spanning context would carry the other maze's turns.
  it("refuses entries holding more than one round", () => {
    // Written out rather than through `entry` above, which pins level and game to 1.
    let clock = 0
    const at = (game: number, level: number, turn: number, payload: string, details?: unknown): LogEntry =>
      ({epochMs: (clock += 1000), time: "2026-08-31T09-00-00+02-00", level, game, turn, log: "info", payload, details})
    const round = (game: number, level: number, move: string) => [
      at(game, level, 0, LOG_EVENTS.levelStarted, {level}),
      at(game, level, 1, LOG_EVENTS.response, {payload: {message: {content: `{"moves":["${move}"]}`}}}),
    ]
    const twoRounds = [...round(1, 1, "MoveUp"), ...round(1, 2, "MoveDown")]

    expect(() => buildPlayedRound(twoRounds, buildContext(twoRounds, {label: "two"})))
      .toThrow(/handed 2 rounds/)

    // Answered one at a time, each with its own context, every round holds only its own turn.
    const perRound = groupEntriesByRound(twoRounds).map((group) => roundOf(group.entries))
    expect(perRound.map((one) => one.turns.length)).toEqual([1, 1])
  })

  // Entries that hold no round at all - an empty log. Nothing to build, and nothing to invent.
  it("builds no round from entries that hold none", () => {
    expect(buildPlayedRound([], buildContext([], {label: "empty"}))).toBeNull()
  })
})

describe("buildPlayedRounds", () => {
  const round = (game: number, level: number, content: string) => [
    entry(LOG_EVENTS.levelStarted, {startPosition: {x: 1, y: 1}}, {turn: 0}),
    ...turn(0, {tools: ["get_maze_structure"], content}),
  ].map((record) => ({...record, game, level}))

  it("keeps a retry of the same level as its own round", () => {
    // A retry regenerates the maze, so grouping by level alone would merge two different mazes and draw
    // a path crossing walls that exist in neither. Asked of buildPlayedRounds rather than of a report: a
    // report answers one round, so it has nowhere to put the second.
    const levels = playedRounds([
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

// --- One record per seat that played ---

// The object-form entry builder these blocks were written against: every field defaulted, so a case
// states only what it is about. Distinct from `entry` above, which takes its payload positionally.
const logEntry = (over: Record<string, unknown> = {}) => ({
  epochMs: 1788000000000,
  time: "2026-08-30 21:00:00",
  turn: 1,
  level: 1,
  game: 2,
  log: "info" as const,
  payload: LOG_EVENTS.request,
  details: {},
  ...over,
}) as LogEntry

// One record per seat, from one pass over the round. Everything here is what a single-agent log could
// not distinguish: a round-wide set says which providers appeared in a file, never which seat used one.
describe("agentsFromRound", () => {
  const seat = (
    name: string, turn: number, cells: string[], decay: number | null = null, seatId: number | null = null,
  ) => ({
    turn, seatId, playerName: name, before: cells[0] ?? null, moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1,
    cells, rejectedMove: null, decayCharged: decay,
  })
  const setup = (over: Partial<RawTurnSetup> = {}): RawTurnSetup =>
    ({seatId: null, model: null, echoedModel: null, api: null, endpoint: null, reasoning: null, ...over})

  // The path every log takes once the upstream fix lands: the turn states its own seat and model, and
  // nothing has to be recovered from a decorated label.
  it("reads a turn that states its own seat and model", () => {
    const [only] = agentsFromRound(
      new Map([[0, setup({model: "deepseek-v4-pro:cloud", api: "ollama"})]]),
      [seat("Momo", 0, ["0,0", "1,0"], null, 2)],
      null,
    )

    expect(only?.seatId).toBe(2)
    expect(only?.models).toEqual(["deepseek-v4-pro:cloud"])
    expect(only?.apis).toEqual(["ollama"])
  })

  // Two names for one model: the request declares "moonshotai/Kimi-K3:baseten", the response echoes
  // "moonshotai/Kimi-K3" with the inference provider trimmed off. Reporting both would read as a seat
  // that ran two models - the very thing agentSettingsCheck flags - so the fuller declared name wins.
  it("prefers the declared model over the provider's trimmed echo", () => {
    const [only] = agentsFromRound(
      new Map([[0, setup({
        model: "moonshotai/Kimi-K3:baseten",
        echoedModel: "moonshotai/Kimi-K3",
      })]]),
      [seat("Momo", 0, ["0,0", "1,0"])],
      null,
    )

    expect(only?.models).toEqual(["moonshotai/Kimi-K3:baseten"])
  })

  // An echo is still the model's name, just short of where it was served from, and a seat reported with
  // no model at all says less. Older logs take this path: nothing declared a model before the upstream
  // fix attached one to every request.
  it("falls back to the echo where no turn declared a model", () => {
    const [only] = agentsFromRound(
      new Map([[0, setup({echoedModel: "moonshotai/Kimi-K3"})]]),
      [seat("Momo", 0, ["0,0", "1,0"])],
      null,
    )

    expect(only?.models).toEqual(["moonshotai/Kimi-K3"])
  })

  // The case the flattened fields could not express at all.
  it("keeps each seat's setup to itself", () => {
    const seats = agentsFromRound(
      new Map([
        [0, setup({model: "gemma4", api: "ollama", reasoning: "max"})],
        [1, setup({model: "glm-5.1", api: "openai", reasoning: "high"})],
      ]),
      [seat("Katara", 0, ["0,0", "1,0"]), seat("Bumi", 1, ["1,0", "2,0"])],
      null,
    )

    expect(seats.map((agent) => agent.name)).toEqual(["Katara", "Bumi"])
    expect(seats.map((agent) => agent.models)).toEqual([["gemma4"], ["glm-5.1"]])
    expect(seats.map((agent) => agent.apis)).toEqual([["ollama"], ["openai"]])
    expect(seats.map((agent) => agent.reasoningEfforts)).toEqual([["max"], ["high"]])
  })

  // A stated seat is the log's answer; acting order is only a stand-in for logs that state none.
  it("orders by the seat the log stated, not by who moved first", () => {
    const seats = agentsFromRound(
      new Map(),
      [seat("Katara", 0, ["0,0", "1,0"], null, 2), seat("Bumi", 1, ["1,0", "2,0"], null, 1)],
      null,
    )

    expect(seats.map((agent) => `${agent.name}/${String(agent.seatId)}`)).toEqual(["Bumi/1", "Katara/2"])
    expect(seats.map((agent, index) => agentSeatLabel(agent, index))).toEqual([
      "Bumi \u00b7 Agent at Seat 1",
      "Katara \u00b7 Agent at Seat 2",
    ])
  })

  // A log whose requests carry no player label attributes no turn, but the outcome still names who
  // finished. Dropping that seat would report a round as having no agents when the log names one.
  it("keeps a seat the outcome names but no turn produced", () => {
    const seats = agentsFromRound(new Map(), [], {outcome: "won", agent: {playerName: "Kora"}})

    expect(seats.map((agent) => agent.name)).toEqual(["Kora"])
  })
})

describe("agentsFromRound, on a log that states its own seats", () => {
  const MAZE = {
    index_chars: ["|", "---", "-", "   ", " ", "\n"],
    structure_checksum: "0x74af82cb14470b9d",
    structure:
      "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
    dimensions: {numCols: 6, numRows: 4, area: 24},
  }

  type Shape = "upstream" | "legacy"
  type Seat = {seatId: number; name: string; model: string; api: string; reasoning: string}
  const KATARA: Seat = {seatId: 1, name: "Katara", model: "gemma4:cloud", api: "ollama", reasoning: "max"}
  const BUMI: Seat = {seatId: 2, name: "Bumi", model: "moonshotai/Kimi-K3:baseten", api: "huggingface", reasoning: "high"}
  const endpointOf = (seat: Seat) => `http://localhost:11434/${seat.name.toLowerCase()}`

  // What the turn before this one did, read off the request that follows it - the offset turnReports
  // owns. Included so the performance half of each record is a real number rather than null: it is
  // joined to a seat by the same name the setup half is, and a test where both are null would pass with
  // the join broken.
  const replayOfPreviousTurn = {
    lastMoveStatus: "applied",
    lastSubmittedMoves: ["MoveDown"],
    lastAppliedMoveIndex: 0,
    lastReplayStartCell: [0, 0],
    chargedMovesCount: 3,
  }

  /** One request's details, in whichever shape the log was written in.
   *
   * "upstream" states the seat and the full model outright on the request; "legacy" is every log written
   * so far - a decorated label, no seat, no model, the model recoverable only from the response echo. */
  const requestDetails = (seat: Seat, shape: Shape, replay: boolean) => {
    const common = {
      tools: [{name: "get_maze_structure"}],
      messages: [
        {role: "tool", content: JSON.stringify({
          currentCell: [0, 0],
          filteredTraversalHistory: [{seatId: null, playerName: seat.name, cell: [0, 0], openMoves: [["MoveDown", "unvisited"]]}],
        })},
        ...(replay ? [{role: "tool", content: JSON.stringify(replayOfPreviousTurn)}] : []),
      ],
      api: seat.api,
      endpoint: endpointOf(seat),
      reasoning: seat.reasoning,
    }

    // The decorated label is on every request and stays there - the upstream fields are additions to it,
    // not replacements, so both shapes below carry it.
    const labelled = {...common, player: `${seat.name} the Trailblazer - 0.9591x`}

    return shape === "upstream"
      ? {...labelled, seatId: seat.seatId, playerName: seat.name, model: seat.model}
      : labelled
  }

  // A two-seat round: Katara on turn 1, Bumi on turn 2, Katara making the final dash.
  const round = (shape: Shape): LogEntry[] => [
    logEntry({turn: 0, payload: LOG_EVENTS.levelStarted, details: {
      startPosition: {x: 1, y: 1}, destinationCell: {row: 0, col: 5}, maze: MAZE,
    }}),
    logEntry({turn: 1, payload: LOG_EVENTS.request, details: requestDetails(KATARA, shape, false)}),
    // The echo, always the trimmed name: the provider drops the ":provider" suffix a declared name has.
    logEntry({turn: 1, payload: LOG_EVENTS.response, details: {
      payload: {model: must(KATARA.model.split(":")[0], "a trimmed name"), message: {content: '{"moves":["MoveDown"]}'}},
    }}),
    logEntry({turn: 2, payload: LOG_EVENTS.request, details: requestDetails(BUMI, shape, true)}),
    logEntry({turn: 2, payload: LOG_EVENTS.response, details: {
      payload: {model: must(BUMI.model.split(":")[0], "a trimmed name"), message: {content: '{"moves":["MoveDown"]}'}},
    }}),
    logEntry({turn: 3, payload: LOG_EVENTS.levelWon, details: {
      outcome: "won", traversalSpeed: "1.0000",
      agent: {playerName: "Katara", seatId: 1, model: "gemma4:cloud", enabled: true},
      playerPosition: {x: 1, y: 3}, playerUniqueCellsVisited: 2, decayUnitsCharged: 3,
    }}),
  ]

  const agentsOf = (shape: Shape): AgentSummary[] =>
    playedRound(round(shape)).agents

  it("reads the seat, the full model and the connection off every request", () => {
    expect(agentsOf("upstream")).toEqual([
      {
        name: "Katara", seatId: 1, models: ["gemma4:cloud"], apis: ["ollama"],
        endpoints: ["http://localhost:11434/katara"], reasoningEfforts: ["max"],
        // Its own turn's charge and cell, not the round's total: the figures the replay panels read.
        uniqueCells: 1, decayCharged: 3, traversalSpeed: 1,
      },
      {
        name: "Bumi", seatId: 2, models: ["moonshotai/Kimi-K3:baseten"], apis: ["huggingface"],
        endpoints: ["http://localhost:11434/bumi"], reasoningEfforts: ["high"],
        // No replay record covers turn 2, so nothing settled what it charged. Null, not zero.
        uniqueCells: 1, decayCharged: null, traversalSpeed: null,
      },
    ])
  })

  // The round-end `agent` record is the one place a log states a seat today - and in every log to hand
  // it is the ONLY place, sitting on "Agent level won." where it names whoever made the final dash. It is
  // not a per-turn fact, so it must never stand in for one: on a two-seat round, reading it as a fallback
  // on a request would report the finisher's seat and model on the turns the other seat played.
  //
  // Bumi played turn 2 and Katara finished, so Bumi is where that mistake would show.
  it("never lets the finisher's record describe another seat's turn", () => {
    // The finishing record, moved onto every request as well, which is the shape that would trip it.
    const finisher = {seatId: 1, playerName: "Katara", model: "gemma4:cloud", enabled: true}
    const entries = round("legacy").map((logEntry) =>
      logEntry.payload === LOG_EVENTS.request
        ? {...logEntry, details: {...logEntry.details as Record<string, unknown>, agent: finisher}}
        : logEntry
    )

    const seats = playedRound(entries).agents
    expect(seats.map((agent) => agent.name)).toEqual(["Katara", "Bumi"])
    // Bumi keeps their own turn, unlabelled by the seat and model that belong to Katara alone.
    expect(seats.map((agent) => [agent.seatId, agent.models])).toEqual([
      [1, ["gemma4:cloud"]],
      [null, ["moonshotai/Kimi-K3"]],
    ])
  })

  // The join is by name, and the label is where a legacy log puts it: "Aang the Backtracker - 0.9591x".
  // The name is read out of the label itself, so a seat named nowhere else in the log - not in a traversal
  // history, not in a round-end record - is still attributed, with its charge, its cells and its setup.
  //
  // Both shapes reach the same answer here, which is the point: a stated playerName needs no recovery, and
  // a label parses to the same name.
  it("attributes a turn whose label names a player the log mentions nowhere else", () => {
    const stranger = (shape: Shape): LogEntry[] => [
      logEntry({turn: 0, payload: LOG_EVENTS.levelStarted, details: {
        startPosition: {x: 1, y: 1}, destinationCell: {row: 0, col: 5}, maze: MAZE,
      }}),
      logEntry({turn: 1, payload: LOG_EVENTS.request, details: {
        ...(shape === "upstream" ? {seatId: 4, playerName: "Aang", model: "gemma4:cloud"} : {}),
        player: "Aang the Backtracker - 0.9591x",
        api: "ollama",
        // Katara's history, not Aang's: the name "Aang" appears in this log only inside the label.
        messages: [{role: "tool", content: JSON.stringify({
          currentCell: [0, 0],
          filteredTraversalHistory: [{seatId: null, playerName: "Katara", cell: [0, 0], openMoves: [["MoveDown", "unvisited"]]}],
        })}],
      }}),
      logEntry({turn: 1, payload: LOG_EVENTS.response, details: {
        payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}},
      }}),
    ]

    expect(playedRound(stranger("upstream")).turns.map((turn) => turn.playerName))
      .toEqual(["Aang"])
    expect(playedRound(stranger("upstream")).agents.map((agent) => [agent.name, agent.apis]))
      .toEqual([["Aang", ["ollama"]]])

    // And with nothing stated, from the label alone.
    expect(playedRound(stranger("legacy")).turns.map((turn) => turn.playerName))
      .toEqual(["Aang"])
    expect(playedRound(stranger("legacy")).agents.map((agent) => agent.name))
      .toEqual(["Aang"])
  })

  // The declared name and the echo are one model named twice. A round that ran one model per seat must
  // report no drift, or the check that exists to catch a changed setting cries on every clean log.
  it("reports no drift when the provider echoes the trimmed name back", () => {
    const check = agentSettingsCheck(agentsOf("upstream"))
    expect(check.outcome).toBe("passed")
    expect(check.detail).toBe("2 seats, each on one model, endpoint and reasoning effort throughout")
  })

  // A stated seat is identity enough on its own. Before the seat was what identified a record, a turn
  // whose name did not resolve was dropped whole - its model, its endpoint and its charge with it - even
  // though the request said plainly which seat played it.
  it("reports a seat that stated its number and no name", () => {
    const entries = [
      logEntry({turn: 0, payload: LOG_EVENTS.levelStarted, details: {
        startPosition: {x: 1, y: 1}, destinationCell: {row: 0, col: 5}, maze: MAZE,
      }}),
      // No player, no playerName: the seat and the model are all this request states.
      logEntry({turn: 1, payload: LOG_EVENTS.request, details: {
        seatId: 7, model: "gemma4:cloud", api: "ollama", endpoint: "http://localhost:11434/api/chat",
      }}),
      logEntry({turn: 1, payload: LOG_EVENTS.response, details: {
        payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}},
      }}),
    ]

    const seats = playedRound(entries).agents
    expect(seats.map((agent) => [agent.seatId, agent.name, agent.models, agent.apis]))
      .toEqual([[7, "", ["gemma4:cloud"], ["ollama"]]])
    // Named by the one thing known about it, with no dangling separator where a name would go.
    expect(agentSeatLabel(must(seats[0], "a seat"), 0)).toBe("Agent at Seat 7")
  })

  // The per-seat figures are gathered against the record itself, not against a name or a number, and this
  // is the round that shows why: two seats that stated their numbers and no player. Keyed by name they
  // both answer to "" and their cells merge - seat 1 reporting 3 for a turn that entered one. Keyed by the
  // number, a legacy round is the mirror of it: every seatId is null until the outcome fills one in, so
  // every seat shares that key instead.
  it("counts each seat's cells against the seat, not against its name or number", () => {
    const played = (turn: number, seatId: number, cells: string[]) => ({
      turn, seatId, playerName: null, before: cells[0] ?? null, moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1,
      cells, rejectedMove: null, decayCharged: null,
    })

    const stating = (seatId: number): RawTurnSetup => ({
      seatId, model: null, echoedModel: null, api: null, endpoint: null, reasoning: null,
    })

    const seats = agentsFromRound(
      new Map([[0, stating(1)], [1, stating(2)]]),
      // Different corners of the maze, so a merged set is visible in the count rather than hidden by an
      // overlap: one cell entered against two.
      [played(0, 1, ["0,0", "1,0"]), played(1, 2, ["5,5", "5,6", "5,7"])],
      null,
    )

    expect(seats.map((agent) => [agent.seatId, agent.name, agent.uniqueCells])).toEqual([
      [1, "", 1],
      [2, "", 2],
    ])
  })

  // The same argument for the echoes. Two nameless seats whose providers echoed different models: keyed by
  // name both lists merge, so each seat reports two models it never ran - and agentSettingsCheck reads a
  // seat holding two models as a setting that changed mid-round, turning a clean pair into a finding.
  it("keeps each seat's echoed model against the seat, not against its name", () => {
    const echoing = (echoedModel: string, seatId: number): RawTurnSetup => ({
      seatId, model: null, echoedModel, api: null, endpoint: null, reasoning: null,
    })
    const played = (turn: number, seatId: number, cells: string[]) => ({
      turn, seatId, playerName: null, before: cells[0] ?? null, moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1,
      cells, rejectedMove: null, decayCharged: null,
    })

    const seats = agentsFromRound(
      new Map([[0, echoing("gemma4", 1)], [1, echoing("glm-5.1", 2)]]),
      [played(0, 1, ["0,0", "1,0"]), played(1, 2, ["5,5", "5,6"])],
      null,
    )

    expect(seats.map((agent) => [agent.seatId, agent.models])).toEqual([[1, ["gemma4"]], [2, ["glm-5.1"]]])
    expect(agentSettingsCheck(seats).outcome).toBe("passed")
  })

  // The outcome is matched to a seat by the number it states, before the name it states. Both are on the
  // record and they can point at different things: a seat that stated its number and left its name to a
  // label nothing resolved is nameless in the roster, while the outcome names a player for it.
  //
  // Matched by name only, that lookup misses and the outcome's seat is added as a second record - one
  // round, one seat that played, two rows, the speed on the row with no turns behind it.
  it("matches the outcome to a seat by the number it states, not only the name", () => {
    const entries = [
      logEntry({turn: 0, payload: LOG_EVENTS.levelStarted, details: {
        startPosition: {x: 1, y: 1}, destinationCell: {row: 0, col: 5}, maze: MAZE,
      }}),
      // States its seat and nothing a name can be recovered from.
      logEntry({turn: 1, payload: LOG_EVENTS.request, details: {seatId: 3, model: "gemma4:cloud", api: "ollama"}}),
      logEntry({turn: 1, payload: LOG_EVENTS.response, details: {
        payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}},
      }}),
      logEntry({turn: 2, payload: LOG_EVENTS.levelWon, details: {
        outcome: "won", traversalSpeed: "1.0000",
        agent: {seatId: 3, playerName: "Momo", model: "gemma4:cloud"},
        playerPosition: {x: 1, y: 3}, playerUniqueCellsVisited: 1, decayUnitsCharged: 1,
      }}),
    ]

    const seats = playedRound(entries).agents

    // One seat, and it is the one that played: the outcome filled in the name it knew.
    expect(seats.map((agent) => [agent.seatId, agent.name, agent.traversalSpeed])).toEqual([[3, "", 1]])
  })

  // A round where only some turns state a seat is one seat, not two halves of one. Mixed logs are what a
  // rollout looks like from the outside: the change lands mid-experiment, or a replayed round is older.
  it("adopts a seat met earlier by name alone", () => {
    const entries = [
      logEntry({turn: 0, payload: LOG_EVENTS.levelStarted, details: {
        startPosition: {x: 1, y: 1}, destinationCell: {row: 0, col: 5}, maze: MAZE,
      }}),
      logEntry({turn: 1, payload: LOG_EVENTS.request, details: requestDetails(KATARA, "legacy", false)}),
      logEntry({turn: 1, payload: LOG_EVENTS.response, details: {
        payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}},
      }}),
      logEntry({turn: 2, payload: LOG_EVENTS.request, details: requestDetails(KATARA, "upstream", false)}),
      logEntry({turn: 2, payload: LOG_EVENTS.response, details: {
        payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}},
      }}),
    ]

    const seats = playedRound(entries).agents
    expect(seats.map((agent) => [agent.seatId, agent.name, agent.models]))
      .toEqual([[1, "Katara", ["gemma4:cloud"]]])
  })

  // Adopting changes the record's identity mid-fold: its seat number goes from null to 1. So a side table
  // keyed on anything derived from the record - the name, the number, or the two joined - orphans whatever
  // was filed before the change, and the seat is credited with half its walk and half its echoes.
  it("keeps a seat's whole walk when a later turn numbers it", () => {
    const echoing = (echoedModel: string): RawTurnSetup => ({
      seatId: null, model: null, echoedModel, api: null, endpoint: null, reasoning: null,
    })
    const played = (turn: number, seatId: number | null, cells: string[]) => ({
      turn, seatId, playerName: "Katara", before: cells[0] ?? null, moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1,
      cells, rejectedMove: null, decayCharged: null,
    })

    const seats = agentsFromRound(
      new Map([[0, echoing("gemma4")], [1, echoing("glm-5.1")]]),
      // Turn 0 names the player and states no seat; turn 1 states seat 1 for the same player.
      [played(0, null, ["0,0", "1,0"]), played(1, 1, ["1,0", "2,0", "3,0"])],
      null,
    )

    expect(seats.map((agent) => [agent.seatId, agent.name, agent.uniqueCells, agent.models]))
      .toEqual([[1, "Katara", 3, ["gemma4", "glm-5.1"]]])
  })

  // The other half of the promise: the stated fields are additions, and a log carrying none of them reads
  // the same. Everything the two shapes can agree on, they agree on - the names, the order, and every
  // performance figure - and the only differences are the two things a log without them cannot carry.
  it("reads a log that states neither of them, unchanged", () => {
    const legacy = agentsOf("legacy")

    expect(legacy.map((agent) => [agent.name, agent.uniqueCells, agent.decayCharged, agent.traversalSpeed]))
      .toEqual(agentsOf("upstream").map((agent) => [agent.name, agent.uniqueCells, agent.decayCharged, agent.traversalSpeed]))
    expect(legacy.map((agent) => agent.apis)).toEqual([["ollama"], ["huggingface"]])

    // The seat is the round-end record's alone, so only the seat it names has one.
    expect(legacy.map((agent) => agent.seatId)).toEqual([1, null])
    // And the model is the echo, short of the suffix saying where it was served from.
    expect(legacy.map((agent) => agent.models)).toEqual([["gemma4:cloud"], ["moonshotai/Kimi-K3"]])
  })
})

// The replay's move names are the move commands themselves, and the model's submitted list is the same
// vocabulary, so the two compare directly. Read as anything else - a prefix stripped off one side, say -
// and the comparison that decides whether Tapoo's own account of a turn is trusted stops matching.
describe("the moves a replay reports", () => {
  const outcomeOf = (moves: string[]) => toolMessage({
    lastMoveStatus: "applied",
    predictionStatus: "all-applied",
    lastReplayStartIndex: 0,
    lastReplayStartCell: {row: 20, col: 18},
    lastSubmittedMoves: moves,
    lastAppliedMoveIndex: moves.length - 1,
    chargedMovesCount: 1,
  })

  const roundOf = (submitted: string[], reported: string[]) => playedRound([
    logEntry({turn: 0, payload: LOG_EVENTS.request, details: {tools: [], messages: [
      toolMessage({currentCell: {row: 20, col: 18}}),
    ]}}),
    logEntry({turn: 0, payload: LOG_EVENTS.response, details: {
      payload: {message: {content: JSON.stringify({moves: submitted})}},
    }}),
    logEntry({turn: 1, payload: LOG_EVENTS.request, details: {tools: [], messages: [outcomeOf(reported)]}}),
  ])

  // Tapoo's own account of the turn: where the replay began, how far it got, what it charged.
  it("trusts the record when the reported moves are the submitted ones", () => {
    const moves = ["MoveLeft", "MoveLeft", "MoveDown", "MoveLeft"]
    const [only] = roundOf(moves, moves).turns

    expect(only).toMatchObject({before: "20,18", applied: 4, decayCharged: 1, rejectedMove: null})
    expect(only?.cells).toEqual(["20,18", "20,17", "20,16", "21,16", "21,15"])
  })

  // A record describing another turn's prediction. Falling through to the derivation is the point: a
  // wrong path drawn confidently is worse than one the log did not settle.
  it("falls through to the derivation when the record describes other moves", () => {
    const [only] = roundOf(["MoveLeft", "MoveLeft"], ["MoveUp", "MoveRight"]).turns

    expect(only?.decayCharged).toBeNull()
  })
})

// Both sides of the trust test are read the same way: the applicable prefix. A record listing a command
// the maze has no move for describes a prediction whose prefix ends there too, so the two still meet -
// and Tapoo's own account of where the replay began and how far it got is used rather than derived.
describe("a replay reporting a command the maze cannot read", () => {
  it("compares the prefix on both sides, and still trusts the record", () => {
    const moves = ["MoveDown", "Teleport"]
    const round = playedRound([
      logEntry({turn: 0, payload: LOG_EVENTS.request, details: {tools: [], messages: [
        toolMessage({currentCell: {row: 0, col: 0}}),
      ]}}),
      logEntry({turn: 0, payload: LOG_EVENTS.response, details: {
        payload: {message: {content: JSON.stringify({moves})}},
      }}),
      logEntry({turn: 1, payload: LOG_EVENTS.request, details: {tools: [], messages: [toolMessage({
        lastMoveStatus: "invalid-move",
        lastSubmittedMoves: moves,
        lastAppliedMoveIndex: 0,
        lastReplayStartCell: {row: 0, col: 0},
        chargedMovesCount: 2,
      })]}}),
    ])

    const [only] = round.turns
    expect(only).toMatchObject({before: "0,0", applied: 1, submittedCount: 2, decayCharged: 2})
    expect(only?.moves).toEqual(["MoveDown"])
  })
})
