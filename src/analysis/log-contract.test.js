import { describe, expect, it } from "vitest"

import {
  AGENT_API_MODE,
  DECLARED_TOOLS,
  LOG_ENVELOPE_NAME,
  LOG_EVENTS,
  MOVES,
  cellKey,
  classifyTraversalSpeed,
  parseTapooLogExport,
  stepFrom,
} from "./log-contract.js"

const entry = (over = {}) => ({
  epochMs: 1788000000000,
  time: "2026-08-30 21:00:00",
  turn: 1,
  level: 1,
  game: 2,
  log: "info",
  payload: LOG_EVENTS.request,
  details: {},
  ...over,
})

const envelope = (over = {}) => ({
  name: LOG_ENVELOPE_NAME,
  version: "2.5.1",
  mode: AGENT_API_MODE,
  downloadedAt: "2026-08-30T21-00-00+02-00",
  entries: [entry()],
  ...over,
})

describe("maze geometry", () => {
  it("steps a cell by each move's delta", () => {
    expect(stepFrom(cellKey(2, 3), "MoveUp")).toBe("1,3")
    expect(stepFrom(cellKey(2, 3), "MoveDown")).toBe("3,3")
    expect(stepFrom(cellKey(2, 3), "MoveLeft")).toBe("2,2")
    expect(stepFrom(cellKey(2, 3), "MoveRight")).toBe("2,4")
  })

  it("names exactly the four commands Tapoo accepts", () => {
    // C1.Q3 checks submitted moves against these keys, so an extra one would silently widen the rubric.
    expect(Object.keys(MOVES).sort()).toEqual(["MoveDown", "MoveLeft", "MoveRight", "MoveUp"])
  })

  it("declares the three context tools C3 asks one question about, in order", () => {
    expect(DECLARED_TOOLS).toEqual([
      "get_maze_structure",
      "get_prediction_rules",
      "get_last_prediction_outcome",
    ])
  })
})

describe("classifyTraversalSpeed", () => {
  it.each([
    [0, "Backtracker"],
    [0.9999, "Backtracker"],
    [1, "Navigator"],
    [1.0001, "Trailblazer"],
    ["1.5000", "Trailblazer"],
  ])("classifies %p", (speed, expected) => {
    expect(classifyTraversalSpeed(speed)).toBe(expected)
  })

  it.each([[Number.NaN], [undefined], [null], ["not a number"], [-1]])(
    "never defaults %p upward",
    (speed) => {
      // A missing denominator must never read as Trailblazer: the rubric says so outright, and this is
      // the value a report prints beside a winning round.
      expect(classifyTraversalSpeed(speed)).toBe("Backtracker")
    },
  )
})

describe("parseTapooLogExport", () => {
  it("accepts a well-formed export and normalizes what it carries", () => {
    const result = parseTapooLogExport(envelope())

    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([])
    expect(result.value).toMatchObject({name: "tapoo", version: "2.5.1", mode: AGENT_API_MODE})
    expect(result.value.entries).toHaveLength(1)
  })

  it.each([
    ["a non-object", 42, /object at the top level/],
    ["null", null, /object at the top level/],
    ["an array", [entry()], /object at the top level/],
    ["another tool's JSON", {name: "something-else", entries: []}, /Not a Tapoo log export/],
    ["a missing entries array", {name: LOG_ENVELOPE_NAME}, /missing its `entries` array/],
  ])("refuses %s", (_label, value, expected) => {
    const result = parseTapooLogExport(value)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(expected)
  })

  it("refuses an export whose entries are all unreadable", () => {
    // storage-logs writes stand-ins for records that failed to decode. A log of nothing but those has
    // no evidence in it, and answering the rubric from it would report "not observed" about a file
    // that was never readable.
    const result = parseTapooLogExport(envelope({entries: [{epochMs: -1, log: "info"}]}))

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no readable entries/)
  })

  it("analyzes an unknown version rather than refusing it", () => {
    // Refusing an unrecognized build would make the analyzer useless against exactly the logs most
    // worth inspecting - those from a Tapoo newer than this app.
    const result = parseTapooLogExport(envelope({version: undefined}))

    expect(result.ok).toBe(true)
    expect(result.value.version).toBeNull()
    expect(result.warnings.join(" ")).toMatch(/no Tapoo version/)
  })

  it("warns when the round was not agent-api, since the rubric describes no other", () => {
    const result = parseTapooLogExport(envelope({mode: "human"}))

    expect(result.ok).toBe(true)
    expect(result.warnings.join(" ")).toMatch(/not "agent-api"/)
  })

  it.each([
    [1, [{epochMs: -1, log: "info"}], "1 entry did not match the log entry shape and was skipped."],
    [
      2,
      [{epochMs: -1, log: "info"}, {nonsense: true}],
      "2 entries did not match the log entry shape and were skipped.",
    ],
  ])("counts %i skipped entries and agrees with itself grammatically", (_count, bad, expected) => {
    const result = parseTapooLogExport(envelope({entries: [entry(), ...bad]}))

    expect(result.ok).toBe(true)
    expect(result.warnings).toContain(expected)
    expect(result.value.entries).toHaveLength(1)
  })

  it.each([
    ["no payload", {payload: undefined}],
    ["a numeric payload", {payload: 7}],
    ["no epochMs", {epochMs: undefined}],
    ["an unknown log level", {log: "trace"}],
  ])("drops an entry with %s", (_label, over) => {
    const result = parseTapooLogExport(envelope({entries: [entry(), entry(over)]}))

    expect(result.value.entries).toHaveLength(1)
    expect(result.warnings.join(" ")).toMatch(/did not match the log entry shape/)
  })

  it("keeps an entry that predates the turn, level and game counters", () => {
    // Those fields are checked but not required: older logs still analyze, and buildContext has an
    // explicit fallback for a missing turn.
    const older = entry()
    delete older.turn
    delete older.level
    delete older.game
    const result = parseTapooLogExport(envelope({entries: [older]}))

    expect(result.ok).toBe(true)
    expect(result.value.entries).toHaveLength(1)
    expect(result.warnings).toEqual([])
  })
})
