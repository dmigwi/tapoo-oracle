import {describe, expect, it} from "vitest"

import {EVENT_CLASSES, KNOWN_EVENTS, levelClassOf} from "./log-events"
import {gameIdentityKey, turnsAreStated} from "./geometry"
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
