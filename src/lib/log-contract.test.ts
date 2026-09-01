import { describe, expect, it } from "vitest"

import {AGENT_API_MODE, DECLARED_TOOLS, assistantMessage, responseUsage, LOG_ENVELOPE_NAME, LOG_EVENTS, MOVES, cellKey, classifyTraversalSpeed, parseTapooLogExport, stepFrom} from "./log-contract"
import {loadTapooLogFromUrl, validateOnlineJsonUrl} from "./share-link"
import type {LogEntry} from "./types"
import {at, expectErr, expectOk, messagesOf} from "./test-support";

// `over` is deliberately not Partial<LogEntry>: several cases hand it values no producer would write -
// a numeric payload, an unknown level - which is exactly the shape parseTapooLogExport is asked to
// reject. Typing the overrides as a valid entry would make those cases unwriteable.
const entry = (over: Record<string, unknown> = {}) => ({
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
    expect(expectOk(result).warnings).toEqual([])
    expect(expectOk(result).value).toMatchObject({name: "tapoo", version: "2.5.1", mode: AGENT_API_MODE})
    expect(expectOk(result).value.entries).toHaveLength(1)
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
    expect(expectErr(result).error).toMatch(expected)
  })

  it("refuses an export whose entries are all unreadable", () => {
    // storage-logs writes stand-ins for records that failed to decode. A log of nothing but those has
    // no evidence in it, and answering the rubric from it would report "not observed" about a file
    // that was never readable.
    const result = parseTapooLogExport(envelope({entries: [{epochMs: -1, log: "info"}]}))

    expect(result.ok).toBe(false)
    expect(expectErr(result).error).toMatch(/no readable entries/)
  })

  it("analyzes an unknown version rather than refusing it", () => {
    // Refusing an unrecognized build would make the analyzer useless against exactly the logs most
    // worth inspecting - those from a Tapoo newer than this app.
    const result = parseTapooLogExport(envelope({version: undefined}))

    expect(result.ok).toBe(true)
    expect(expectOk(result).value.version).toBeNull()
    expect(messagesOf(expectOk(result).warnings).join(" ")).toMatch(/no Tapoo version/)
  })

  it("warns when the round was not agent-api, since the rubric describes no other", () => {
    const result = parseTapooLogExport(envelope({mode: "human"}))

    expect(result.ok).toBe(true)
    expect(messagesOf(expectOk(result).warnings).join(" ")).toMatch(/not "agent-api"/)
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
    expect(messagesOf(expectOk(result).warnings)).toContain(expected)
    expect(expectOk(result).value.entries).toHaveLength(1)
  })

  it.each([
    ["no payload", {payload: undefined}],
    ["a numeric payload", {payload: 7}],
    ["no epochMs", {epochMs: undefined}],
    ["an unknown log level", {log: "trace"}],
  ])("drops an entry with %s", (_label, over) => {
    const result = parseTapooLogExport(envelope({entries: [entry(), entry(over)]}))

    expect(expectOk(result).value.entries).toHaveLength(1)
    expect(messagesOf(expectOk(result).warnings).join(" ")).toMatch(/did not match the log entry shape/)
  })

  it("keeps an entry that predates the turn, level and game counters", () => {
    // Those fields are checked but not required: older logs still analyze, and buildContext has an
    // explicit fallback for a missing turn.
    // Deleted through a partial view: on LogEntry these fields are required, and that is the point -
    // the test is about a log that predates them, which is not a LogEntry any producer would write.
    const older: Partial<LogEntry> = entry()
    delete older.turn
    delete older.level
    delete older.game
    const result = parseTapooLogExport(envelope({entries: [older]}))

    expect(result.ok).toBe(true)
    expect(expectOk(result).value.entries).toHaveLength(1)
    expect(expectOk(result).warnings).toEqual([])
  })
})

describe("validateOnlineJsonUrl", () => {
  it("accepts online URLs only", () => {
    expect(validateOnlineJsonUrl("https://example.com/report.json")).toEqual({
      ok: true,
      url: "https://example.com/report.json",
    })
    expect(validateOnlineJsonUrl("file:///tmp/report.json")).toMatchObject({
      ok: false,
      error: expect.stringContaining("http:// or https://"),
    })
  })
})

describe("loadTapooLogFromUrl", () => {
  it("downloads and validates the Tapoo log behind a URL", async () => {
    const text = JSON.stringify(envelope())
    const result = await loadTapooLogFromUrl("https://example.com/report.json", {
      fetchText: async (url) => {
        expect(url).toBe("https://example.com/report.json")
        return text
      },
    })

    expect(result).toMatchObject({
      ok: true,
      url: "https://example.com/report.json",
      source: {name: LOG_ENVELOPE_NAME, mode: AGENT_API_MODE, sourceUrl: "https://example.com/report.json"},
      warnings: [],
    })
    expect(expectOk(result).source.entries).toHaveLength(1)
  })

  it("attaches the validated URL when the downloaded JSON is not a Tapoo log", async () => {
    const result = await loadTapooLogFromUrl("https://example.com/report.json", {
      fetchText: async () => JSON.stringify({name: "other", entries: []}),
    })

    expect(result).toMatchObject({
      ok: false,
      url: "https://example.com/report.json",
      error: expect.stringContaining("Not a Tapoo log export"),
    })
  })
})

describe("what reaches the reader as a warning", () => {
  // The warning banner is headed "Read with care", and it is for caveats about the log: a
  // non-agent-api mode, a missing build version, entries that did not decode. Those bound how much the
  // verdicts are worth, and a reader can weigh them.
  //
  // Findings about this codebase are a different thing. An event with no rubric question means a
  // question has not been written yet, and a level contradicting its payload is a bug in the producer.
  // Neither is something the reader can act on, and both would read as a reason to distrust the report.
  it("says nothing about an event the rubric has no question for", () => {
    // Both sentences are real: they appear in a 2,004-entry glm-5.1 log and in no LOG_EVENTS entry.
    const result = parseTapooLogExport(envelope({entries: [
      entry(),
      entry({payload: "Malformed agent prediction response.", log: "warn"}),
      entry({payload: "Recovered after a connection-error retry.", log: "warn"}),
    ]}))

    expect(expectOk(result).warnings).toEqual([])
    // Still readable entries, still analyzed - the events are simply not scored.
    expect(expectOk(result).value.entries).toHaveLength(3)
  })

  it("says nothing about a level that contradicts its own payload", () => {
    const result = parseTapooLogExport(envelope({entries: [entry({log: "warn"})]}))

    expect(expectOk(result).warnings).toEqual([])
  })

  it("still reports the caveats that are about the log itself", () => {
    const result = parseTapooLogExport(envelope({mode: "human", version: undefined}))
    const warnings = messagesOf(expectOk(result).warnings).join(" ")

    expect(warnings).toMatch(/not "agent-api"/)
    expect(warnings).toMatch(/no Tapoo version/)
  })
})

describe("the encoded maze payload", () => {
  // Validating this is the same kind of question as validating the envelope's mode or an entry's
  // payload - is what arrived what it claims to be - so it is answered here, on the way in, rather
  // than discovered later by the view that tried to draw it.
  //
  // Validation is also what decides the impact, because it is what knows the difference between a
  // payload that never came and one that came damaged.
  const REAL_MAZE = {
    index_chars: ["|", "---", "-", "   ", " ", "\n"],
    structure_checksum: "0x74af82cb14470b9d",
    structure:
      "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
    dimensions: {numCols: 6, numRows: 4, area: 24},
  }

  const started = (details: unknown) =>
    envelope({entries: [entry({payload: LOG_EVENTS.levelStarted, details})]})

  it("says nothing when the maze arrives intact", () => {
    expect(expectOk(parseTapooLogExport(started({maze: REAL_MAZE}))).warnings).toEqual([])
  })

  it("calls an absent maze incomplete: nothing is wrong, a section is missing", () => {
    const warnings = expectOk(parseTapooLogExport(started({level: 1}))).warnings

    expect(warnings).toHaveLength(1)
    expect(at(warnings, 0).impact).toBe("incomplete")
    expect(at(warnings, 0).message).toMatch(/carries no encoded maze/)
    expect(at(warnings, 0).message).toMatch(/no traversal replay and no maze statistics/)
  })

  it("calls a damaged maze inaccurate: a payload arrived and is not what it claims", () => {
    // One character changed, so the structure no longer matches the checksum it carries.
    const damaged = {...REAL_MAZE, structure: `1${REAL_MAZE.structure.slice(1)}`}
    const warnings = expectOk(parseTapooLogExport(started({maze: damaged}))).warnings

    expect(warnings).toHaveLength(1)
    expect(at(warnings, 0).impact).toBe("inaccurate")
    expect(at(warnings, 0).message).toMatch(/did not decode/)
    expect(at(warnings, 0).message).toMatch(/checksum/)
  })

  it("calls a malformed maze inaccurate too", () => {
    const warnings = expectOk(parseTapooLogExport(started({maze: {dimensions: {}}}))).warnings

    expect(at(warnings, 0).impact).toBe("inaccurate")
  })

  it("names the round, so a multi-round log says which one", () => {
    const warnings = expectOk(parseTapooLogExport(envelope({entries: [
      entry({payload: LOG_EVENTS.levelStarted, details: {maze: REAL_MAZE}, game: 6, level: 54}),
      entry({payload: LOG_EVENTS.levelStarted, details: {level: 55}, game: 6, level: 55}),
    ]}))).warnings

    expect(warnings).toHaveLength(1)
    expect(at(warnings, 0).message).toMatch(/^Game 6 level 55 /)
  })
})

describe("reading the model's message from a provider response", () => {
  // Tapoo logs the provider's response body verbatim, and its three adapters
  // (frontend/app/agent/providers.ts) agree on nothing structural. Reading only Ollama's shape is what
  // made a real 1,459-entry OpenAI log analyze to zero predictions and zero turns, with the replay
  // scrubber reading "0 / 0" under a maze that drew correctly - an empty response legitimately
  // happens, so 719 of them in a row failed silently. Anthropic would have failed identically.
  it("reads Ollama: a message with thinking and tool_calls", () => {
    expect(assistantMessage({
      message: {role: "assistant", content: '{"moves":["MoveUp"]}', thinking: "considering",
        tool_calls: [{function: {name: "get_maze_structure", arguments: "{}"}}]},
    })).toEqual({content: '{"moves":["MoveUp"]}', toolNames: ["get_maze_structure"], reasoning: "considering"})
  })

  it("reads OpenAI: a message nested under the first choice, reasoning under its own name", () => {
    expect(assistantMessage({
      choices: [{finish_reason: "stop", message: {role: "assistant", content: '{"moves":["MoveDown"]}',
        reasoning_content: "considering", tool_calls: [{function: {name: "get_prediction_rules"}}]}}],
    })).toEqual({content: '{"moves":["MoveDown"]}', toolNames: ["get_prediction_rules"], reasoning: "considering"})
  })

  it("reads Anthropic: typed content blocks, with no message or choices at all", () => {
    // The shape that would otherwise have counted as an empty response for a whole log.
    expect(assistantMessage({
      role: "assistant",
      content: [
        {type: "thinking", thinking: "considering", signature: "sig"},
        {type: "text", text: '{"moves":["MoveLeft"]}'},
        {type: "tool_use", id: "call_1", name: "get_last_prediction_outcome", input: {}},
      ],
    })).toEqual({content: '{"moves":["MoveLeft"]}', toolNames: ["get_last_prediction_outcome"], reasoning: "considering"})
  })

  it("joins Anthropic blocks rather than taking the first", () => {
    // One reply can be spread across several text blocks, and taking the first would truncate the
    // prediction to whatever fitted in it.
    expect(assistantMessage({content: [
      {type: "text", text: '{"moves":'}, {type: "text", text: '["MoveUp"]}'},
      {type: "thinking", thinking: "a"}, {type: "thinking", thinking: "b"},
    ]})).toEqual({content: '{"moves":["MoveUp"]}', toolNames: [], reasoning: "ab"})
  })

  it("scores only the first choice", () => {
    // Tapoo asks for one completion. Scoring a second would credit the agent with a prediction it was
    // never judged on.
    expect(assistantMessage({choices: [{message: {content: "first"}}, {message: {content: "second"}}]})?.content)
      .toBe("first")
  })

  it("tells the providers apart by shape, not by a label beside the body", () => {
    // The log records `api` and `endpoint` too, but a body that looks like a response is better
    // evidence about that body than a label written next to it.
    expect(assistantMessage({message: {content: "a"}, choices: [{message: {content: "b"}}]})?.content).toBe("a")
  })

  it("reports a tool-only response as having no content, not as empty", () => {
    // Every provider sends these while the agent is gathering context: real responses, no prediction.
    const message = assistantMessage({choices: [{finish_reason: "tool_calls",
      message: {content: "", tool_calls: [{function: {name: "get_maze_structure"}}]}}]})

    expect(message).toEqual({content: "", toolNames: ["get_maze_structure"], reasoning: null})
  })

  it("says nothing when there is no message to read", () => {
    for (const payload of [null, undefined, {}, {choices: []}, {choices: [{}]}, {message: "text"}, "x", 7]) {
      expect(assistantMessage(payload)).toBeNull()
    }
  })
})

describe("what the provider reported about its own work", () => {
  it("reads Ollama's counts and duration", () => {
    expect(responseUsage({prompt_eval_count: 3234, eval_count: 35, total_duration: 1_100_956_836, done_reason: "stop"}))
      .toEqual({promptTokens: 3234, completionTokens: 35, reasoningTokens: null,
        cachedPromptTokens: null, durationNs: 1_100_956_836, finishReason: "stop"})
  })

  it("reads OpenAI's usage block, including the two a reasoning model adds", () => {
    expect(responseUsage({
      usage: {prompt_tokens: 3250, completion_tokens: 20, total_tokens: 3270,
        completion_tokens_details: {reasoning_tokens: 18}, prompt_tokens_details: {cached_tokens: 2304}},
      choices: [{finish_reason: "stop", message: {content: "x"}}],
    })).toEqual({promptTokens: 3250, completionTokens: 20, reasoningTokens: 18,
      cachedPromptTokens: 2304, durationNs: null, finishReason: "stop"})
  })

  it("reads Anthropic's usage: output_tokens is the completion side, thinking included", () => {
    // Tapoo's adapter reads output_tokens alone and notes it already covers extended thinking, so the
    // two are not added together - that would double-count the thinking against the completion budget.
    expect(responseUsage({
      role: "assistant", stop_reason: "end_turn",
      usage: {input_tokens: 3100, output_tokens: 240, cache_read_input_tokens: 2048},
    })).toEqual({promptTokens: 3100, completionTokens: 240, reasoningTokens: null,
      cachedPromptTokens: 2048, durationNs: null, finishReason: "end_turn"})
  })

  it("reads each provider's own name for how the model stopped", () => {
    expect(responseUsage({done_reason: "stop"}).finishReason).toBe("stop")
    expect(responseUsage({choices: [{finish_reason: "length"}]}).finishReason).toBe("length")
    expect(responseUsage({stop_reason: "max_tokens"}).finishReason).toBe("max_tokens")
  })

  it("says null, not zero, for what a provider did not report", () => {
    // The distinction matters downstream: zero reasoning tokens is a finding, and "this API does not
    // count them" is not. A row is only shown for the second.
    const usage = responseUsage({prompt_eval_count: 10, eval_count: 2})

    expect(usage.reasoningTokens).toBeNull()
    expect(usage.durationNs).toBeNull()
  })

  it("survives a payload that reports nothing at all", () => {
    for (const payload of [null, undefined, {}, "x", {usage: "no"}, {choices: []}]) {
      expect(responseUsage(payload)).toEqual({promptTokens: null, completionTokens: null,
        reasoningTokens: null, cachedPromptTokens: null, durationNs: null, finishReason: null})
    }
  })
})

describe("a response this analyzer cannot read", () => {
  // The check that was missing when it mattered. A 1,459-entry log analyzed to zero predictions and
  // zero turns because every response was in a provider shape the contract did not know - and each one
  // was silently counted as an "empty response", which legitimately happens.
  //
  // The signal is precise rather than heuristic: across 1,744 responses in the real Ollama and OpenAI
  // logs, not one has an unreadable shape, while the 49 blank ones all carry a readable message with
  // no text. So one unreadable body means a gap in this file, and it is worth saying immediately.
  const response = (payload: unknown) => entry({payload: LOG_EVENTS.response, details: {payload}})

  it("says so, and says what it costs the verdicts", () => {
    const result = parseTapooLogExport(envelope({entries: [
      response({message: {content: '{"moves":["MoveUp"]}'}}),
      response({unknown_provider: {text: "hello"}}),
    ]}))
    const warning = at(expectOk(result).warnings, 0)

    expect(warning.impact).toBe("inaccurate")
    expect(warning.message).toMatch(/1 of 2 model responses could not be read/)
    // The reader has to know a NO may be an artefact rather than a finding.
    expect(warning.message).toMatch(/answered NO may only mean the evidence for it was unreadable/)
  })

  it("says plainly when nothing at all was scored", () => {
    const result = parseTapooLogExport(envelope({entries: [response({choices: "not a list"})]}))

    expect(at(expectOk(result).warnings, 0).message).toMatch(/No prediction in this log was scored/)
  })

  it("stays quiet for a response that is readable but blank", () => {
    // A model stopping early is not a contract gap. Both real logs contain these - 46 and 3 of them -
    // and warning about them would cry wolf on every long run.
    const result = parseTapooLogExport(envelope({entries: [
      response({message: {content: ""}, done_reason: "length"}),
      response({choices: [{finish_reason: "length", message: {content: ""}}]}),
    ]}))

    expect(expectOk(result).warnings).toEqual([])
  })

  it("stays quiet for a tool-only response", () => {
    const result = parseTapooLogExport(envelope({entries: [
      response({message: {content: "", tool_calls: [{function: {name: "get_maze_structure"}}]}}),
    ]}))

    expect(expectOk(result).warnings).toEqual([])
  })
})

