import {describe, expect, it} from "vitest"

import {EVENT_CLASSES, KNOWN_EVENTS, levelClassOf} from "./log-events"
import {decomposeTraversalSpeed, gameIdentityKey, turnsAreStated} from "./geometry"
import type {LogEntry, LogLevel} from "./types"

const entry = (
  payload: string,
  {turn = 0, log = "info", epochMs = 1788000000000}: {turn?: number; log?: LogLevel; epochMs?: number} = {},
): LogEntry => ({epochMs, time: "t", turn, level: 1, game: 2, log, payload, details: {}})

describe("turnsAreStated", () => {
  it("is true only when every entry carries a turn", () => {
    expect(turnsAreStated([entry("a", {turn: 0}), entry("b", {turn: 1})])).toBe(true)

    const unstamped: Partial<LogEntry> = {...entry("b")}
    delete unstamped.turn
    expect(turnsAreStated([entry("a"), unstamped as LogEntry])).toBe(false)
  })

  it("is false for an empty log, which states nothing either way", () => {
    // buildContext falls back to inferring boundaries from predictions, and nothing to infer from is
    // still nothing stated.
    expect(turnsAreStated([])).toBe(false)
  })
})

describe("gameIdentityKey", () => {
  it("keeps a log that named no round out of game zero", () => {
    // Zero is a game Tapoo can number, so an unstamped log keyed "0/0" would answer to a key a genuine
    // game 0 level 0 owns.
    expect(gameIdentityKey({game: 2, level: 1})).toBe("2/1")
    expect(gameIdentityKey({game: null, level: null})).toBe("?/?")
    expect(gameIdentityKey({game: 0, level: 0})).not.toBe(gameIdentityKey({game: null, level: null}))
  })
})

describe("the event vocabulary", () => {
  it("reads the level as what it says about who is answerable", () => {
    expect(levelClassOf("info")).toBe("neutral")
    expect(levelClassOf("warn")).toBe("penalised")
    expect(levelClassOf("error")).toBe("external")
  })

  // Every sentence the agent-api request loop writes, checked against the vocabulary in one place. This is
  // the list that decides whether an event is recognised at all, and a sentence missing from it is counted
  // nowhere and cross-checked against nothing - so it is asserted as a set rather than one at a time.
  it("recognises every sentence the request loop writes, and classes each of them", () => {
    const written = [
      "Agent level started.",
      "Agent request.",
      "Agent response.",
      "Unsupported agent API provider.",
      "Provider HTTP response failed.",
      "Provider response did not include a message.",
      "Agent exhausted the token cap without returning a prediction.",
      "Malformed agent prediction response.",
      "Agent kept re-requesting already-called tools after being told so.",
      "Agent requested an unknown or hallucinated tool.",
      "Tool request could not be serviced.",
      "Request failed before a valid response.",
      // Written by the control layer rather than the request loop, when a failure takes the agent out.
      "Agent disabled after network error.",
    ]

    expect(written.filter((payload) => !KNOWN_EVENTS.has(payload))).toEqual([])
    // And each carries a class, so a level that contradicts it is a finding rather than silence.
    expect(written.filter((payload) => EVENT_CLASSES[payload] === undefined)).toEqual([])
  })
})

// The decomposition is an identity, so what these check is that it stays one: each factor is read off the
// seat's own counts, and their product is that seat's speed to full precision. A test that only checked
// each factor separately would pass on a decomposition that no longer multiplied back.
describe("decomposeTraversalSpeed", () => {
  const seat = (uniqueCells: number, movesApplied: number, turnsTaken: number, decayCharged: number | null) =>
    decomposeTraversalSpeed({settled: {uniqueCells, movesApplied, turnsTaken}, decayCharged})

  it("splits a speed into the three factors it is the product of", () => {
    // 17 cells over 24 landed moves, 24 moves over 16 turns, 16 turns over 17 charges.
    expect(seat(17, 24, 16, 17)).toEqual({
      efficiency: 17 / 24,
      batching: 24 / 16,
      accuracy: 16 / 17,
    })
  })

  it("multiplies back to the seat's own speed", () => {
    const counts = [
      {settled: {uniqueCells: 17, movesApplied: 24, turnsTaken: 16}, decayCharged: 17},
      // The GLM profile: batching hard, then giving a quarter of it back to penalties.
      {settled: {uniqueCells: 483, movesApplied: 620, turnsTaken: 470}, decayCharged: 624},
      // And a seat that barely batches and loses almost nothing.
      {settled: {uniqueCells: 100, movesApplied: 104, turnsTaken: 103}, decayCharged: 105},
    ]

    for (const seatCounts of counts) {
      const factors = decomposeTraversalSpeed(seatCounts)
      const product = (factors?.efficiency ?? 0) * (factors?.batching ?? 0) * (factors?.accuracy ?? 0)

      expect(product).toBeCloseTo(seatCounts.settled.uniqueCells / seatCounts.decayCharged, 12)
    }
  })

  // Batching is the only factor that can carry the product over 1, so a speed above 1.0000 is a seat that
  // batched forward into cells it had never visited - the guarantee the rubric's Trailblazer class rests on.
  it("puts a speed above 1 entirely down to batching", () => {
    const factors = decomposeTraversalSpeed({settled: {uniqueCells: 30, movesApplied: 30, turnsTaken: 20}, decayCharged: 20})

    expect(factors?.efficiency).toBeLessThanOrEqual(1)
    expect(factors?.accuracy).toBeLessThanOrEqual(1)
    expect(factors?.batching).toBeGreaterThan(1)
  })

  // Zeros are the interesting absences, not the missing counts: a seat whose every prediction was refused
  // has no applied moves, and dividing by that answers Infinity - a value that formats as a number and
  // would print as a measurement.
  it("reports nothing where a factor has no denominator", () => {
    expect(seat(17, 0, 16, 17)).toBeNull()
    expect(seat(17, 24, 0, 17)).toBeNull()
    expect(seat(17, 24, 16, 0)).toBeNull()
  })

  it("reports nothing where the round stated no count", () => {
    expect(decomposeTraversalSpeed({settled: null, decayCharged: 17})).toBeNull()
    expect(seat(17, 24, 16, null)).toBeNull()
  })
})
