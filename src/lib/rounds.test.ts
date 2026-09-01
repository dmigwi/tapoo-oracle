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
