import {describe, expect, it} from "vitest"

import {LOG_EVENTS} from "./log-events"
import {buildLevels} from "./rounds"
import {at} from "./test-support"
import type {LogEntry, LogLevel} from "./types"

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

describe("which round an entry belongs to", () => {
  // The bug this exists for: `entry.game ?? 0` was read per entry, so an entry that did not name its
  // round was filed under a fabricated round "0/0" rather than the one in progress. On a log that
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
    expect(at(levels, 0).key).toBe("6/54")
  })

  it("gives that round both its maze and its turns, not one each", () => {
    const level = at(buildLevels(roundMarkersOnly), 0)

    // The pairing is the whole point: a round with a maze and no turns cannot be replayed, and a round
    // with turns and no maze has nothing to draw them on.
    expect(level.encodedMaze).not.toBeNull()
    expect(level.turns).toHaveLength(3)
  })

  it("invents no round that the log never recorded", () => {
    expect(buildLevels(roundMarkersOnly).map((level) => level.key)).not.toContain("0/0")
  })

  it("still separates rounds that do name themselves", () => {
    const levels = buildLevels([
      entry(LOG_EVENTS.levelStarted, {maze: REAL_MAZE}, {turn: 0, game: 6, level: 54}),
      prediction(["MoveDown"], 0),
      entry(LOG_EVENTS.levelStarted, {maze: REAL_MAZE}, {turn: 1, game: 6, level: 55}),
      prediction(["MoveUp"], 1),
    ])

    expect(levels.map((level) => level.key)).toEqual(["6/54", "6/55"])
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
  // began and which move was the last to land. The oracle used to infer both, keying the same payload
  // by its move list - and a move list is not unique to a turn. In a real 464-turn log, 502 readings
  // collapsed onto 86 sequences, 30 of them seen with different applied indexes, and 63 turns ended up
  // with another turn's path.
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
  // nothing becomes a submission. The turn used to vanish from the replay - while Tapoo still counted
  // it and still charged three units for it, its heaviest penalty. The report showed 464 turns against
  // Tapoo's own 473 in one real log, and the decay strip could never reach the round total because its
  // most expensive turns were the missing ones.
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

