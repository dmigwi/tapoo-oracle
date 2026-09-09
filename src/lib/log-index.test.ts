import {describe, expect, it} from "vitest"

import {LOG_EVENTS, levelClassOf} from "./log-events"
import {entriesForTurn, indexLog, levelDisagreements, unknownEvents} from "./log-index"
import {EVENT_CLASSES} from "./log-events"
import {at, must} from "./test-support"
import type {LogEntry, LogLevel} from "./types"

const entry = (
  payload: string,
  {turn = 0, log = "info", epochMs = 1788000000000}: {turn?: number; log?: LogLevel; epochMs?: number} = {},
): LogEntry => ({epochMs, time: "t", turn, level: 1, game: 2, log, payload, details: {}})

// One round the way Tapoo writes it: the level-started entry belongs to turn 0 and the outcome to the
// last turn, so neither sits outside the turn structure.
const round = (turns: number): LogEntry[] => [
  entry(LOG_EVENTS.levelStarted, {turn: 0}),
  ...Array.from({length: turns}, (_, index) => [
    entry(LOG_EVENTS.request, {turn: index, epochMs: 1788000000000 + index * 2000}),
    entry(LOG_EVENTS.response, {turn: index, epochMs: 1788000000001 + index * 2000}),
  ]).flat(),
  entry(LOG_EVENTS.levelWon, {turn: turns - 1}),
]

describe("turn spans", () => {
  it("tiles the entries exactly: no gap, no overlap, nothing dropped", () => {
    // The property that makes the map usable at all. Anything else and a per-turn read either misses
    // entries or counts them twice, and neither shows up as an error - only as a wrong number.
    const entries = round(8)
    const {turns} = indexLog(entries)

    expect(turns.reduce((total, span) => total + (span.end - span.start), 0)).toBe(entries.length)
    expect(turns.every((span, i) => i === 0 || span.start === at(turns, i - 1).end)).toBe(true)
    expect(at(turns, 0).start).toBe(0)
    expect(must(turns.at(-1), "a last span").end).toBe(entries.length)
  })

  it("puts the round's opening and closing entries inside the turns that own them", () => {
    const index = indexLog(round(4))

    // Turn 0 carries levelStarted plus its request/response; the last turn carries the outcome.
    expect(at(index.turns, 0)).toMatchObject({turn: 0, start: 0, end: 3})
    expect(must(index.turns.at(-1), "a last span")).toMatchObject({turn: 3})
    expect(index.summary.turns).toBe(4)
  })

  it("returns a turn's own entries and nothing else", () => {
    const entries = round(5)
    const index = indexLog(entries)

    expect(entriesForTurn(entries, index, {game: 2, level: 1, turn: 2}).map((e) => e.payload))
      .toEqual([LOG_EVENTS.request, LOG_EVENTS.response])
    expect(entriesForTurn(entries, index, {game: 2, level: 1, turn: 2})
      .every((e) => e.turn === 2)).toBe(true)
  })

  it("says nothing rather than guessing when a turn is not indexed", () => {
    const entries = round(3)

    expect(entriesForTurn(entries, indexLog(entries), {game: 2, level: 1, turn: 99})).toEqual([])
  })

  it("keeps reset turn numbers separate across rounds", () => {
    const entries = [
      entry(LOG_EVENTS.request, {turn: 0}),
      {...entry(LOG_EVENTS.response, {turn: 0}), game: 3, level: 2},
    ]
    const index = indexLog(entries)

    expect(index.turns).toHaveLength(2)
    expect(index.summary.turns).toBe(2)
    expect(entriesForTurn(entries, index, {game: 2, level: 1, turn: 0})).toEqual([entries[0]])
    expect(entriesForTurn(entries, index, {game: 3, level: 2, turn: 0})).toEqual([entries[1]])
  })

  it("declines to index a log written before the turn counter", () => {
    // buildContext infers these boundaries from predictions, which needs to know what a parsed
    // prediction is. Reproducing that here would give two answers that could disagree.
    const older = round(3).map((entry) => {
      const copy: Partial<LogEntry> = {...entry}
      delete copy.turn
      return copy as LogEntry
    })
    const index = indexLog(older)

    expect(index.turnSource).toBe("unavailable")
    expect(index.turns).toEqual([])
    expect(index.summary.turns).toBe(0)
    // The rest of the summary still describes the log.
    expect(index.summary.entries).toBe(older.length)
  })
})

describe("summary", () => {
  it("counts levels and classes, and spans the recorded time", () => {
    const index = indexLog([
      entry(LOG_EVENTS.request),
      entry(LOG_EVENTS.tokenCapExhausted, {log: "warn", epochMs: 1788000005000}),
      entry(LOG_EVENTS.requestFailed, {log: "error", epochMs: 1788000009000}),
    ])

    expect(index.summary.levels).toEqual({info: 1, warn: 1, error: 1})
    expect(index.summary.penalised).toBe(1)
    expect(index.summary.external).toBe(1)
    expect(index.summary.firstEpochMs).toBe(1788000000000)
    expect(index.summary.lastEpochMs).toBe(1788000009000)
  })

  it("counts every payload it saw, known to the rubric or not", () => {
    const index = indexLog([entry(LOG_EVENTS.request), entry(LOG_EVENTS.request),
      entry("Recovered after a connection-error retry.", {log: "warn"})])

    expect(index.summary.events.get(LOG_EVENTS.request)).toBe(2)
    expect(index.summary.events.get("Recovered after a connection-error retry.")).toBe(1)
  })
})

describe("classification", () => {
  it("reads the level as what it says about who is answerable", () => {
    expect(levelClassOf("info")).toBe("neutral")
    expect(levelClassOf("warn")).toBe("penalised")
    expect(levelClassOf("error")).toBe("external")
  })

  it("names events the rubric has no question for", () => {
    // Real, and named in no LOG_EVENTS entry: it appears in a 2,004-entry glm-5.1 log, so without this it
    // falls through every branch in buildContext and is counted nowhere.
    const index = indexLog([
      entry(LOG_EVENTS.request),
      entry("Recovered after a connection-error retry.", {log: "warn"}),
      entry("Recovered after a connection-error retry.", {log: "warn"}),
      entry("Something Tapoo added later.", {log: "warn"}),
    ])

    expect(unknownEvents(index)).toEqual([
      {payload: "Recovered after a connection-error retry.", count: 2},
      {payload: "Something Tapoo added later.", count: 1},
    ])
  })

  // Every sentence the agent-api request loop writes, checked against the vocabulary in one place. This is
  // the list that decides whether an event is recognised at all, and a sentence missing from it is counted
  // nowhere and cross-checked against nothing - so it is asserted as a set rather than one at a time.
  it("recognises every sentence the request loop writes", () => {
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

    const index = indexLog(written.map((payload) => entry(payload, {log: "info"})))
    expect(unknownEvents(index)).toEqual([])

    // And each carries a class, so a level that contradicts it is a finding rather than silence.
    expect(written.filter((payload) => EVENT_CLASSES[payload] === undefined)).toEqual([])
  })

  // The sentence this check exists to find, once it is found. An unmodelled event is readable and real and
  // counted nowhere, so naming it in LOG_EVENTS is what moves it out of this list and into a figure -
  // "Times disabled" in the diagnostics.
  it("no longer reports a disabling as an event it cannot name", () => {
    const index = indexLog([entry(LOG_EVENTS.agentDisabled, {log: "error"})])

    expect(unknownEvents(index)).toEqual([])
    // Classed as the network's doing, like the failures behind it, so it never reaches the profile.
    expect(index.summary.external).toBe(1)
    expect(levelDisagreements([entry(LOG_EVENTS.agentDisabled, {log: "error"})])).toEqual([])
  })

  it("counts an unknown event by its level even though it cannot name it", () => {
    const index = indexLog([entry("Something Tapoo added later.", {log: "warn"})])

    expect(index.summary.penalised).toBe(1)
    expect(unknownEvents(index)).toHaveLength(1)
  })

  it("reports a level that contradicts its own payload, without preferring either", () => {
    const disagreements = levelDisagreements([
      entry(LOG_EVENTS.request, {log: "warn"}),
      entry(LOG_EVENTS.request, {log: "warn"}),
      entry(LOG_EVENTS.requestFailed, {log: "error"}),
    ])

    expect(disagreements).toEqual([
      {payload: LOG_EVENTS.request, expected: "neutral", actual: "penalised", count: 2},
    ])
  })

  it("has nothing to say about an unknown event's level", () => {
    // There is no expected class to contradict, so this is not a disagreement - it is the gap that
    // unknownEvents already reports.
    expect(levelDisagreements([entry("Something Tapoo added later.", {log: "error"})])).toEqual([])
  })
})
