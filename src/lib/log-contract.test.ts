import { describe, expect, it } from "vitest"

import fixtureData from "./_snapshot_/tapoo-v2.5.1-gemma4-base-agent-api-log.json" with {type: "json"}

import {AGENT_API_MODE, DECLARED_TOOLS, assistantMessage, responseUsage, LOG_ENVELOPE_NAME, LOG_EVENTS, MOVES, agentSeatLabel, agentSettingsCheck, agentsFromRound, classifyTraversalSpeed, parseGameRound, getCellKey, parseTapooLogText, statusesFromLogged, stepFrom, turnReports} from "./log-contract"
import {loadTapooLogFromUrl, validateOnlineJsonUrl} from "./share-link"
import type {AgentSummary, LogEntry, TurnSetup, ValidationCheck} from "./types"
import {buildLevels, groupEntriesByRound, roundLabel} from "./rounds"
import {fnv1a64Checksum} from "./utils"
import {at, expectErr, expectOk, messagesOf, must} from "./test-support";

// `over` is deliberately not Partial<LogEntry>: several cases hand it values no producer would write -
// a numeric payload, an unknown level - which is exactly the shape parseTapooLogText is asked to
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

// Every parse goes in through text, because that is the only way in: the envelope contract used to be a
// second exported function taking already-parsed JSON, and nothing but this file ever called it so.
const parse = (value: unknown) => parseTapooLogText(JSON.stringify(value))

describe("maze geometry", () => {
  it("steps a cell by each move's delta", () => {
    expect(stepFrom(getCellKey({row: 2, col: 3}), "MoveUp")).toBe("1,3")
    expect(stepFrom(getCellKey({row: 2, col: 3}), "MoveDown")).toBe("3,3")
    expect(stepFrom(getCellKey({row: 2, col: 3}), "MoveLeft")).toBe("2,2")
    expect(stepFrom(getCellKey({row: 2, col: 3}), "MoveRight")).toBe("2,4")
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

// Both logged shapes carry the status and both must be read: compacted logs write [move, status] pairs,
// uncompacted ones nest it in the value. openMovesFromLogged drops it from each on purpose - it wants exits.
describe("statusesFromLogged", () => {
  it("reads the compacted [move, status] pairs", () => {
    expect(statusesFromLogged([["MoveUp", "explored"], ["MoveDown", "oscillating"]])).toEqual([
      ["MoveUp", "explored"],
      ["MoveDown", "oscillating"],
    ])
  })

  it("reads the uncompacted object, where the status sits inside the value", () => {
    expect(statusesFromLogged({MoveDown: {row: 1, col: 0, visitStatus: "unvisited"}})).toEqual([
      ["MoveDown", "unvisited"],
    ])
  })

  // A status outside the scale is a shape we do not understand, and colouring a cell from it would be
  // inventing a reading. Dropped rather than passed through.
  it("drops a status the scale does not define", () => {
    expect(statusesFromLogged([["MoveUp", "sideways"], ["MoveDown", "explored"]])).toEqual([
      ["MoveDown", "explored"],
    ])
  })

  it("survives the shapes a producer should never write", () => {
    expect(statusesFromLogged(null)).toEqual([])
    expect(statusesFromLogged("MoveUp")).toEqual([])
    expect(statusesFromLogged([["MoveUp"], 42, null])).toEqual([])
  })

  // The move is narrowed here so a caller can hand it straight to stepFrom. A name the maze cannot
  // apply is dropped at the parse rather than passed on for every caller to guard against - which is
  // what they used to do, each with its own isMove check beside its own call.
  it("drops a name that is not one of the four commands, in either shape", () => {
    expect(statusesFromLogged([["MoveSideways", "explored"], ["MoveUp", "explored"]])).toEqual([
      ["MoveUp", "explored"],
    ])
    expect(statusesFromLogged({
      Teleport: {row: 9, col: 9, visitStatus: "explored"},
      MoveDown: {row: 1, col: 0, visitStatus: "explored"},
    })).toEqual([["MoveDown", "explored"]])
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

describe("parseTapooLogText", () => {
  it("accepts a well-formed export and normalizes what it carries", () => {
    const result = parse(envelope())

    expect(result.ok).toBe(true)
    expect(expectOk(result).warnings).toEqual([])
    expect(expectOk(result).source).toMatchObject({name: "tapoo", version: "2.5.1", mode: AGENT_API_MODE})
    expect(expectOk(result).source.entries).toHaveLength(1)
  })

  it.each([
    ["a non-object", 42, /object at the top level/],
    ["null", null, /object at the top level/],
    ["an array", [entry()], /object at the top level/],
    ["another tool's JSON", {name: "something-else", entries: []}, /Not a Tapoo log export/],
    ["a missing entries array", {name: LOG_ENVELOPE_NAME}, /missing its `entries` array/],
  ])("refuses %s", (_label, value, expected) => {
    const result = parse(value)

    expect(result.ok).toBe(false)
    expect(expectErr(result).error).toMatch(expected)
  })

  it("refuses an export whose entries are all unreadable", () => {
    // storage-logs writes stand-ins for records that failed to decode. A log of nothing but those has
    // no evidence in it, and answering the rubric from it would report "not observed" about a file
    // that was never readable.
    const result = parse(envelope({entries: [{epochMs: -1, log: "info"}]}))

    expect(result.ok).toBe(false)
    expect(expectErr(result).error).toMatch(/no readable entries/)
  })

  it("analyzes an unknown version rather than refusing it", () => {
    // Refusing an unrecognized build would make the analyzer useless against exactly the logs most
    // worth inspecting - those from a Tapoo newer than this app.
    const result = parse(envelope({version: undefined}))

    expect(result.ok).toBe(true)
    expect(expectOk(result).source.version).toBeNull()
    expect(messagesOf(expectOk(result).warnings).join(" ")).toMatch(/no Tapoo version/)
  })

  it("warns when the round was not agent-api, since the rubric describes no other", () => {
    const result = parse(envelope({mode: "human"}))

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
    const result = parse(envelope({entries: [entry(), ...bad]}))

    expect(result.ok).toBe(true)
    expect(messagesOf(expectOk(result).warnings)).toContain(expected)
    expect(expectOk(result).source.entries).toHaveLength(1)
  })

  it.each([
    ["no payload", {payload: undefined}],
    ["a numeric payload", {payload: 7}],
    ["no epochMs", {epochMs: undefined}],
    ["an unknown log level", {log: "trace"}],
  ])("drops an entry with %s", (_label, over) => {
    const result = parse(envelope({entries: [entry(), entry(over)]}))

    expect(expectOk(result).source.entries).toHaveLength(1)
    expect(messagesOf(expectOk(result).warnings).join(" ")).toMatch(/did not match the log entry shape/)
  })

  it("keeps an entry that carries no turn, level or game", () => {
    // Not required, and deliberately so: rounds.test.ts records a real log - hundreds of turns - that
    // stamped game and level on its round boundaries only, and every entry between them would be
    // dropped by a gate that insisted. buildContext, groupEntriesByRound and roundLabel each place such
    // an entry rather than refusing it.
    //
    // Deleted through a partial view: on LogEntry these fields are optional, and this is the shape that
    // makes them so.
    const older: Partial<LogEntry> = entry()
    delete older.turn
    delete older.level
    delete older.game
    const result = parse(envelope({entries: [older]}))

    expect(result.ok).toBe(true)
    expect(expectOk(result).source.entries).toHaveLength(1)
    expect(expectOk(result).warnings).toEqual([])
  })
})

// The visit colours on the replay are read straight out of get_maze_structure payloads, so a damaged one
// would be drawn as fact. content_checksum is over the content Tapoo sent, not the compacted form the
// log keeps, so the check rebuilds the original and hashes that.
// The store exists so the turn offset cannot be applied twice or forgotten. `record` takes the turn that
// carried a payload, `get` takes the turn it covers, and nothing exposes the raw key - which is what
// makes the bug it was extracted from unrepeatable rather than merely fixed.
describe("turnReports", () => {
  it("stores what a request carried under the turn it covers", () => {
    const reports = turnReports<string>()
    reports.record(5, "outcome of turn 4")

    expect(reports.get(4)).toBe("outcome of turn 4")
    // The turn that carried it is not a key. A reader applying the offset itself would land here.
    expect(reports.get(5)).toBeUndefined()
  })

  // Turn 0's payload covers turn -1: there is no turn before the first, so it holds the opening state
  // and matches no turn. rounds.ts guards on it explicitly.
  it("keeps the opening payload under -1", () => {
    const reports = turnReports<string>()
    reports.record(0, "the start")

    expect(reports.get(-1)).toBe("the start")
  })

  // A turn can carry more than one tool message, and the second must not erase the first.
  it("merges when a turn carried more than one payload", () => {
    const reports = turnReports<string[]>()
    reports.record(3, ["a"], (existing, incoming) => [...existing, ...incoming])
    reports.record(3, ["b"], (existing, incoming) => [...existing, ...incoming])

    expect(reports.get(2)).toEqual(["a", "b"])
    expect(reports.size).toBe(1)
  })

  it("replaces when no merge is given", () => {
    const reports = turnReports<string>()
    reports.record(3, "first")
    reports.record(3, "second")

    expect(reports.get(2)).toBe("second")
  })

  // Readers walk this to a bound, so the order is part of the contract rather than a side effect of
  // however the entries happened to arrive.
  it("returns entries ascending by the turn they cover", () => {
    const reports = turnReports<string>()
    for (const turn of [7, 1, 4, 0]) reports.record(turn, `carried on ${turn}`)

    expect(reports.ascending().map(([turn]) => turn)).toEqual([-1, 0, 3, 6])
    expect(reports.size).toBe(4)
    expect(reports.values()).toHaveLength(4)
  })
})

describe("the traversal payload checksum", () => {
  // Through the round parser, one round at a time, which is how the app reads it: the export parse no
  // longer touches a checksum. Every round is asked here so the fixture's payloads are all covered -
  // the app asks only for the round on screen.
  const checksumWarnings = (log: unknown): string[] => {
    const result = parseTapooLogText(JSON.stringify(log))
    if (!result.ok) throw new Error(`fixture did not parse: ${result.error}`)
    return groupEntriesByRound(result.source.entries)
      .flatMap((round) => parseGameRound(round.entries).warnings)
      .map((warning) => warning.message)
      .filter((m) => m.includes("checksum"))
  }

  // The half that matters most: a false positive here would put an accuracy warning on every clean
  // report, and a reader who meets one on a good log stops believing the next one.
  it("is silent on a real export, where all 16 payloads reconstruct byte-exactly", () => {
    expect(checksumWarnings(fixtureData)).toEqual([])
  })

  // The checksum covers fields compaction strips - destinationCell and historyWindowRadius - so they can
  // only come from the round's "Agent level started." entry. A log without one cannot be checked, and
  // saying so by silence is the only honest answer: reporting a mismatch would stamp every payload in an
  // otherwise sound log as damaged, on the strength of something we never had.
  it("stays silent when the round never recorded what the reconstruction needs", () => {
    const log = JSON.parse(JSON.stringify(fixtureData)) as {entries: LogEntry[]}
    for (const entry of log.entries) {
      const details = entry.details as Record<string, unknown> | null
      if (details && "historyWindowRadius" in details) delete details.historyWindowRadius
    }

    expect(checksumWarnings(log)).toEqual([])
  })

  it("reports a payload whose contents no longer match what Tapoo hashed", () => {
    const log = JSON.parse(JSON.stringify(fixtureData)) as {entries: LogEntry[]}
    let tampered = 0
    for (const entry of log.entries) {
      const details = entry.details as {messages?: Array<Record<string, unknown>>} | null
      for (const message of details?.messages ?? []) {
        if (message.role !== "tool" || typeof message.content !== "string") continue
        if (typeof message.content_checksum !== "string") continue
        const payload = JSON.parse(message.content) as {
          filteredTraversalHistory?: Array<{openMoves?: string[][]}>
        }
        const first = payload.filteredTraversalHistory?.[0]?.openMoves?.[0]
        if (!first) continue
        // One status flipped and nothing else: the payload still parses, and would still draw.
        first[1] = "oscillating"
        message.content = JSON.stringify(payload)
        tampered += 1
      }
    }

    expect(tampered).toBe(16)
    expect(checksumWarnings(log)).toEqual([
      "16 maze-structure payloads do not match their checksums, the first at turn 0 of game 2 level 1, so the visit colours on the replay may not be what the agent was shown.",
    ])
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

  it("rejects credentials embedded in a URL", () => {
    expect(validateOnlineJsonUrl("https://reader:secret@example.com/report.json")).toMatchObject({
      ok: false,
      error: expect.stringContaining("credentials"),
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
    const result = parse(envelope({entries: [
      entry(),
      entry({payload: "Malformed agent prediction response.", log: "warn"}),
      entry({payload: "Recovered after a connection-error retry.", log: "warn"}),
    ]}))

    expect(expectOk(result).warnings).toEqual([])
    // Still readable entries, still analyzed - the events are simply not scored.
    expect(expectOk(result).source.entries).toHaveLength(3)
  })

  it("says nothing about a level that contradicts its own payload", () => {
    const result = parse(envelope({entries: [entry({log: "warn"})]}))

    expect(expectOk(result).warnings).toEqual([])
  })

  it("still reports the caveats that are about the log itself", () => {
    const result = parse(envelope({mode: "human", version: undefined}))
    const warnings = messagesOf(expectOk(result).warnings).join(" ")

    expect(warnings).toMatch(/not "agent-api"/)
    expect(warnings).toMatch(/no Tapoo version/)
  })
})

// Moved off the export parse: whether a round's maze decodes is a statement about that round, and
// parseGameRound is what answers it - for the round a reader opened, not for all of them at load.
// Moved off the export parse: what a round's maze decodes to is a statement about that round, and
// parseGameRound is what answers it - for the round a reader opened, not for all of them at load.
//
// It answers by *returning* the maze rather than warning about it. The replay already reports a maze
// that will not decode, in the space the traversal should have occupied and with what the reader loses
// by it; a second notice above the tabs added nothing and made one fault look like two.
describe("the encoded maze payload", () => {
  const REAL_MAZE = {
    index_chars: ["|", "---", "-", "   ", " ", "\n"],
    structure_checksum: "0x74af82cb14470b9d",
    structure:
      "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
    dimensions: {numCols: 6, numRows: 4, area: 24},
  }

  // One round's entries, which is what the round parser takes.
  const started = (details: unknown) => [entry({payload: LOG_EVENTS.levelStarted, details})]

  it("hands back a maze that decodes, with the stats its start and destination imply", () => {
    const {maze, warnings} = parseGameRound(started({
      maze: REAL_MAZE,
      startPosition: {x: 1, y: 1},
      destinationCell: {row: 0, col: 5},
    }))

    expect(warnings).toEqual([])
    expect(expectOk(must(maze, "a decoded maze")).stats.successPathCells).toBe(18)
  })

  it("hands back nothing for a round that carried no maze, and says nothing either", () => {
    const {maze, warnings} = parseGameRound(started({level: 1}))

    expect(maze).toBeNull()
    expect(warnings).toEqual([])
  })

  // A structure that fails its own checksum arrived damaged. The failure travels on the result, where
  // the replay reads it, rather than as a warning the reader meets twice.
  it("hands back the failure for a damaged maze", () => {
    const damaged = {...REAL_MAZE, structure: `1${REAL_MAZE.structure.slice(1)}`}
    const {maze, warnings} = parseGameRound(started({maze: damaged}))

    expect(expectErr(must(maze, "a decode attempt")).error).toMatch(/checksum/)
    expect(warnings).toEqual([])
  })

  it("hands back the failure for a malformed one too", () => {
    expect(expectErr(must(parseGameRound(started({maze: {dimensions: {}}})).maze, "a decode attempt")))
      .toHaveProperty("ok", false)
  })

  // A group holds a replay of the same level, so more than one opening. buildLevels reads the first,
  // so that is the one returned - the two must not disagree about which maze the round had.
  it("returns the first opening's maze when a round was replayed", () => {
    const {maze} = parseGameRound([
      entry({payload: LOG_EVENTS.levelStarted, details: {maze: REAL_MAZE}, game: 6, level: 54}),
      entry({payload: LOG_EVENTS.levelStarted, details: {maze: {dimensions: {}}}, game: 6, level: 54}),
    ])

    expect(expectOk(must(maze, "a decoded maze")).stats.cells).toBe(24)
  })
})

// One record per seat, from one pass over the round. Everything here is what a single-agent log could
// not distinguish: a round-wide set says which providers appeared in a file, never which seat used one.
describe("agentsFromRound", () => {
  const seat = (
    name: string, turn: number, cells: string[], decay: number | null = null, seatId: number | null = null,
  ) => ({
    turn, seatId, playerName: name, before: cells[0] ?? null, moves: ["MoveDown"], applied: 1,
    cells, rejectedMove: null, decayCharged: decay,
  })
  const setup = (over: Partial<TurnSetup> = {}): TurnSetup =>
    ({seatId: null, playerName: null, model: null, echoedModel: null, api: null, endpoint: null, reasoning: null, ...over})

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

// A seat whose settings changed mid-round was not one experiment. Possible to check only because the
// settings are read per turn - a roster declared once could not contradict itself.
// Tapoo is being changed to attach the seat and the full model name to every request payload. This block
// is that contract, written down and checked before the change lands: the fields in the places agreed,
// and the same round in the shape logs are written in today, so neither can be broken for the other.
// A log that stamps no game and no level on any entry is still one round, and it still needs something
// to click. The branch that names it was reachable and unasserted - deleting it as dead weight would
// have left a tab with an empty label, which is why it is pinned here rather than trusted to be unused.
//
// No log in this repo takes this path: the v2.5.0 sample and the v2.5.1 snapshot both stamp all three
// counters on every entry. It is asserted because the code tolerates the shape, not because one is known
// to exist - and a tolerance nothing checks is a tolerance that quietly stops working.
describe("a log that names no round at all", () => {
  it("gathers it as one round with a name a reader can click", () => {
    const unstamped = [
      entry({turn: 1, game: undefined, level: undefined}),
      entry({turn: 2, game: undefined, level: undefined}),
    ]

    const groups = groupEntriesByRound(unstamped)

    expect(groups).toHaveLength(1)
    expect(at(groups, 0).identity).toEqual({game: null, level: null})
    expect(at(groups, 0).entries).toHaveLength(2)
    expect(roundLabel(at(groups, 0).identity)).toBe("Whole log")
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
    entry({turn: 0, payload: LOG_EVENTS.levelStarted, details: {
      startPosition: {x: 1, y: 1}, destinationCell: {row: 0, col: 5}, maze: MAZE,
    }}),
    entry({turn: 1, payload: LOG_EVENTS.request, details: requestDetails(KATARA, shape, false)}),
    // The echo, always the trimmed name: the provider drops the ":provider" suffix a declared name has.
    entry({turn: 1, payload: LOG_EVENTS.response, details: {
      payload: {model: must(KATARA.model.split(":")[0], "a trimmed name"), message: {content: '{"moves":["MoveDown"]}'}},
    }}),
    entry({turn: 2, payload: LOG_EVENTS.request, details: requestDetails(BUMI, shape, true)}),
    entry({turn: 2, payload: LOG_EVENTS.response, details: {
      payload: {model: must(BUMI.model.split(":")[0], "a trimmed name"), message: {content: '{"moves":["MoveDown"]}'}},
    }}),
    entry({turn: 3, payload: LOG_EVENTS.levelWon, details: {
      outcome: "won", traversalSpeed: "1.0000",
      agent: {playerName: "Katara", seatId: 1, model: "gemma4:cloud", enabled: true},
      playerPosition: {x: 1, y: 3}, playerUniqueCellsVisited: 2, decayUnitsCharged: 3,
    }}),
  ]

  const agentsOf = (shape: Shape): AgentSummary[] =>
    must(buildLevels(round(shape))[0], "a round").agents

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

    const seats = must(buildLevels(entries)[0], "a round").agents
    expect(seats.map((agent) => agent.name)).toEqual(["Katara", "Bumi"])
    // Bumi keeps their own turn, unlabelled by the seat and model that belong to Katara alone.
    expect(seats.map((agent) => [agent.seatId, agent.models])).toEqual([
      [1, ["gemma4:cloud"]],
      [null, ["moonshotai/Kimi-K3"]],
    ])
  })

  // The join is by name, and today a name is recovered from the decorated label by matching it against
  // the names the log states elsewhere - a traversal history, a round-end record. A seat that appears in
  // neither is unattributable from its label alone, and an unattributed turn is a turn belonging to no
  // seat: its charge, its cells and its whole setup go unreported. A stated playerName settles it
  // outright, which is what reading it buys even though the label is never going away.
  it("attributes a turn whose label names a player the log mentions nowhere else", () => {
    const stranger = (shape: Shape): LogEntry[] => [
      entry({turn: 0, payload: LOG_EVENTS.levelStarted, details: {
        startPosition: {x: 1, y: 1}, destinationCell: {row: 0, col: 5}, maze: MAZE,
      }}),
      entry({turn: 1, payload: LOG_EVENTS.request, details: {
        ...(shape === "upstream" ? {seatId: 4, playerName: "Aang", model: "gemma4:cloud"} : {}),
        player: "Aang the Backtracker - 0.9591x",
        api: "ollama",
        // Katara's history, not Aang's: the name "Aang" appears in this log only inside the label.
        messages: [{role: "tool", content: JSON.stringify({
          currentCell: [0, 0],
          filteredTraversalHistory: [{seatId: null, playerName: "Katara", cell: [0, 0], openMoves: [["MoveDown", "unvisited"]]}],
        })}],
      }}),
      entry({turn: 1, payload: LOG_EVENTS.response, details: {
        payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}},
      }}),
    ]

    expect(must(buildLevels(stranger("upstream"))[0], "a round").turns.map((turn) => turn.playerName))
      .toEqual(["Aang"])
    expect(must(buildLevels(stranger("upstream"))[0], "a round").agents.map((agent) => [agent.name, agent.apis]))
      .toEqual([["Aang", ["ollama"]]])

    // What the same log yields with nothing stated: the label alone cannot name the seat, so the turn is
    // attributed to nobody and the round reports no agent at all.
    expect(must(buildLevels(stranger("legacy"))[0], "a round").turns.map((turn) => turn.playerName))
      .toEqual([null])
    expect(must(buildLevels(stranger("legacy"))[0], "a round").agents).toEqual([])
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
      entry({turn: 0, payload: LOG_EVENTS.levelStarted, details: {
        startPosition: {x: 1, y: 1}, destinationCell: {row: 0, col: 5}, maze: MAZE,
      }}),
      // No player, no playerName: the seat and the model are all this request states.
      entry({turn: 1, payload: LOG_EVENTS.request, details: {
        seatId: 7, model: "gemma4:cloud", api: "ollama", endpoint: "http://localhost:11434/api/chat",
      }}),
      entry({turn: 1, payload: LOG_EVENTS.response, details: {
        payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}},
      }}),
    ]

    const seats = must(buildLevels(entries)[0], "a round").agents
    expect(seats.map((agent) => [agent.seatId, agent.name, agent.models, agent.apis]))
      .toEqual([[7, "", ["gemma4:cloud"], ["ollama"]]])
    // Named by the one thing known about it, with no dangling separator where a name would go.
    expect(agentSeatLabel(must(seats[0], "a seat"), 0)).toBe("Agent at Seat 7")
  })

  // A round where only some turns state a seat is one seat, not two halves of one. Mixed logs are what a
  // rollout looks like from the outside: the fix lands mid-experiment, or a replayed round predates it.
  it("adopts a seat met earlier by name alone", () => {
    const entries = [
      entry({turn: 0, payload: LOG_EVENTS.levelStarted, details: {
        startPosition: {x: 1, y: 1}, destinationCell: {row: 0, col: 5}, maze: MAZE,
      }}),
      entry({turn: 1, payload: LOG_EVENTS.request, details: requestDetails(KATARA, "legacy", false)}),
      entry({turn: 1, payload: LOG_EVENTS.response, details: {
        payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}},
      }}),
      entry({turn: 2, payload: LOG_EVENTS.request, details: requestDetails(KATARA, "upstream", false)}),
      entry({turn: 2, payload: LOG_EVENTS.response, details: {
        payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}},
      }}),
    ]

    const seats = must(buildLevels(entries)[0], "a round").agents
    expect(seats.map((agent) => [agent.seatId, agent.name, agent.models]))
      .toEqual([[1, "Katara", ["gemma4:cloud"]]])
  })

  // The other half of the promise: the upstream fields are additions, and a log carrying none of them
  // still reads exactly as it does today. Everything the two shapes can agree on, they agree on - the
  // names, the order, and every performance figure - and the only differences are the two things the
  // legacy log genuinely does not carry.
  it("still reads a log that states neither, exactly as it does today", () => {
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

describe("agentSettingsCheck", () => {
  const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
    name: "Katara", seatId: null, models: ["gemma4"], apis: ["ollama"], endpoints: [], 
    reasoningEfforts: ["max"], uniqueCells: null, decayCharged: null, traversalSpeed: null, ...over,
  })

  it("passes a round whose seats each held one setup throughout", () => {
    const check = agentSettingsCheck([agent(), agent({name: "Bumi"})])

    expect(check.outcome).toBe("passed")
    expect(check.detail).toBe("2 seats, each on one model, endpoint and reasoning effort throughout")
    expect(agentSettingsCheck([agent()]).detail).toBe("one seat, on one model, endpoint and reasoning effort throughout")
  })

  it("reports a seat that changed model during the round", () => {
    const check = agentSettingsCheck([agent({models: ["gemma4", "glm-5.1"]})])

    expect(check.outcome).toBe("failed")
    expect(check.detail).toMatch(/Katara ran 2 different settings/)
  })

  it("says nothing of a round that recorded no settings at all", () => {
    const check = agentSettingsCheck([agent({models: [], apis: [], reasoningEfforts: []})])

    expect(check.outcome).toBe("unchecked")
  })
})

// The summary the report shows: what was verified, and what could not be.
//
// The checks report only their failures, so a clean log says nothing - and "nothing" covered both a
// round that verified all 16 payloads and a round that could attempt none. These pin the difference.
describe("the validation summary", () => {
  const named = (checks: ValidationCheck[], name: string) => {
    const check = checks.find((candidate) => candidate.name === name)
    if (!check) throw new Error(`no check named ${name}`)
    return check
  }
  const fixtureEntries = () => (fixtureData as unknown as {entries: LogEntry[]}).entries

  it("reports what a real round verified", () => {
    const round = parseGameRound(fixtureEntries())

    expect(round.checks.map((check) => check.outcome)).toEqual(["passed", "passed", "passed", "passed", "passed"])
    expect(round.checks.every((check) => check.scope === "round")).toBe(true)
    expect(named(round.checks, "Traversal payloads").detail).toBe("16 of 16 get_maze_structure results reconstructed byte-exactly")
    expect(named(round.checks, "Agent personas").detail).toMatch(/3 distinct system prompts, of the 4 personas/)
  })

  // Two checks cover the file rather than a round, and say so: an entry that fails the contract is
  // dropped before rounds exist, and whether this analyzer recognises the provider's response shape
  // does not change between rounds. The view marks them so a reader knows they hold for every round.
  it("scopes the file-wide checks to the log, not to a round", () => {
    const parsed = expectOk(parseTapooLogText(JSON.stringify(fixtureData)))

    expect(parsed.checks.map((check) => check.name)).toEqual(["Log entry fields", "Model responses"])
    expect(parsed.checks.every((check) => check.scope === "log")).toBe(true)
    expect(named(parsed.checks, "Log entry fields").detail).toBe("66 of 66 log entries carried a payload, a timestamp and a known log level")
    expect(named(parsed.checks, "Model responses").detail).toBe("32 of 32 model responses were read")
  })

  it("counts entries the entry contract turned away", () => {
    const parsed = expectOk(parseTapooLogText(JSON.stringify(envelope({entries: [entry(), {nonsense: true}]}))))

    expect(named(parsed.checks, "Log entry fields").outcome).toBe("failed")
    expect(named(parsed.checks, "Log entry fields").detail).toMatch(/^1 of 2 log entries lacked a payload/)
    expect(messagesOf(parsed.warnings).join(" ")).toMatch(/did not match the log entry shape/)
  })

  // The other two tools' results are not maze-structure payloads, so they are not this check's
  // business and must not be counted against it. Counting them read as 32 unverifiable payloads on a
  // log where every payload the check covers verified.
  it("counts only the payloads the reconstruction is about", () => {
    expect(named(parseGameRound(fixtureEntries()).checks, "Traversal payloads").detail)
      .not.toMatch(/not checkable/)
  })

  // The case the summary exists for. Strip the history window and the reconstruction has nothing to
  // work from - which is not damage, and is no longer indistinguishable from success either.
  it("says a check could not run, rather than that it passed", () => {
    const stripped = JSON.parse(JSON.stringify(fixtureData)) as {entries: LogEntry[]}
    for (const entry of stripped.entries) {
      const details = entry.details as Record<string, unknown> | null
      if (details && "historyWindowRadius" in details) delete details.historyWindowRadius
    }
    const check = named(parseGameRound(stripped.entries).checks, "Traversal payloads")

    expect(check.outcome).toBe("unchecked")
    expect(check.detail).toMatch(/never recorded the destination cell and history window/)
    // And still silent, because a missing input is not evidence of damage.
    expect(parseGameRound(stripped.entries).warnings).toEqual([])
  })

  // A failure has to read as one, and must not replace the warning that already reports it.
  it("reports a damaged payload as failed, alongside the warning", () => {
    const tampered = JSON.parse(JSON.stringify(fixtureData)) as {entries: LogEntry[]}
    for (const entry of tampered.entries) {
      const details = entry.details as {messages?: Array<Record<string, unknown>>} | null
      for (const message of details?.messages ?? []) {
        if (typeof message.content_checksum === "string") message.content_checksum = "0xdeadbeefdeadbeef"
      }
    }
    const round = parseGameRound(tampered.entries)

    expect(named(round.checks, "Traversal payloads").outcome).toBe("failed")
    expect(named(round.checks, "Traversal payloads").detail).toMatch(/^16 of 16 get_maze_structure results did not match/)
    expect(round.warnings.some((warning) => warning.message.includes("checksum"))).toBe(true)
  })

  it("reports a round that carried no maze as unchecked, not failed", () => {
    const check = named(parseGameRound([entry({payload: LOG_EVENTS.levelStarted})]).checks, "Encoded maze")

    expect(check.outcome).toBe("unchecked")
    expect(check.detail).toMatch(/carried no encoded maze/)
  })

  it("reports responses this analyzer could not read", () => {
    const unreadable = entry({payload: LOG_EVENTS.response, details: {payload: {unknown_provider: {}}}})
    const parsed = expectOk(parseTapooLogText(JSON.stringify(envelope({entries: [unreadable]}))))
    const check = named(parsed.checks, "Model responses")

    expect(check.outcome).toBe("failed")
    expect(check.detail).toMatch(/1 of 1 model responses were in a provider shape/)
  })
})

// What a round told the agent, and whether it told it the same thing throughout.
describe("the prompts and tool descriptions a round carried", () => {
  const sum = (text: string) => fnv1a64Checksum(text)
  const PROMPT = "You are Katara, and you start this level primed for success."
  const DESC = "Get current/destination cells and the nearby explored maze structure in one call."

  const request = (messages: unknown[], tools: unknown[] = []) =>
    entry({payload: LOG_EVENTS.request, details: {messages, tools}})
  const systemMessage = (content: string, checksum = sum(content)) =>
    ({role: "system", content, content_checksum: checksum})
  const tool = (name: string, description: string, checksum = sum(description)) =>
    ({name, description, description_checksum: checksum})

  // The half that matters most: a false positive here would put an accuracy warning on every clean
  // report. The real export carries 128 prompt and description appearances and raises none.
  it("says nothing about a round whose prompts and descriptions are intact", () => {
    expect(parseGameRound((fixtureData as unknown as {entries: LogEntry[]}).entries).warnings).toEqual([])
  })

  it("checks a prompt logged in full against its own checksum", () => {
    const warnings = parseGameRound([request([systemMessage(PROMPT, "0xdeadbeefdeadbeef")])]).warnings

    expect(warnings).toHaveLength(1)
    expect(at(warnings, 0).impact).toBe("inaccurate")
    expect(at(warnings, 0).message).toMatch(/does not match its own checksum/)
  })

  it("checks a tool description the same way", () => {
    const warnings = parseGameRound([request([], [tool("get_maze_structure", DESC, "0xdeadbeefdeadbeef")])]).warnings

    expect(at(warnings, 0).message).toMatch(/does not match its own checksum/)
  })

  // A later appearance is trimmed to 25 characters and an ellipsis, so hashing it would fail on every
  // log. It is checked against the full text logged under the same checksum instead.
  it("accepts a trimmed repeat of a prompt it has already seen in full", () => {
    const trimmed = `${PROMPT.slice(0, 25)}...`
    const warnings = parseGameRound([
      request([systemMessage(PROMPT)]),
      request([systemMessage(trimmed, sum(PROMPT))]),
    ]).warnings

    expect(warnings).toEqual([])
  })

  it("reports a trimmed repeat that is not the text it claims to be", () => {
    const warnings = parseGameRound([
      request([systemMessage(PROMPT)]),
      request([systemMessage("Something else entirely...", sum(PROMPT))]),
    ]).warnings

    expect(at(warnings, 0).message).toMatch(/under one checksum/)
  })

  // A checksum whose full text never appears cannot be checked at all - and that is ordinary, not
  // damage: the real export carries 30 such stubs, because Tapoo logs a prompt in full once and only
  // stubs it after it changes. Saying nothing is the only honest answer.
  it("stays silent on a stub whose full text the round never carried", () => {
    const warnings = parseGameRound([request([systemMessage("You are Katara and your...", "0xfeedfacefeedface")])]).warnings

    expect(warnings).toEqual([])
  })

  // The one thing a round must not do: describe the same tool two ways. Its turns were then answering
  // different instructions, and the tool-use verdicts compare them as if they were not.
  it("reports a tool described two different ways within one round", () => {
    const warnings = parseGameRound([
      request([], [tool("get_maze_structure", DESC)]),
      request([], [tool("get_maze_structure", `${DESC} And something new.`)]),
    ]).warnings

    expect(warnings).toHaveLength(1)
    expect(at(warnings, 0).impact).toBe("inaccurate")
    expect(at(warnings, 0).message).toMatch(/describes the tool get_maze_structure 2 different ways/)
  })

  // The system prompt is not held to that, and must not be: it is rewritten as the player's speed class
  // changes, so a real 16-turn round carries three. Requiring one per round would warn on every log.
  it("accepts a system prompt that changes during the round", () => {
    const second = "You are Katara and your traversal speed is now Navigator."
    const warnings = parseGameRound([
      request([systemMessage(PROMPT)]),
      request([systemMessage(second)]),
    ]).warnings

    expect(warnings).toEqual([])
  })

  // Tapoo assigns four personas - the opening Default, then Trailblazer, Navigator and Backtracker as
  // the traversal speed moves between brackets - so a round cannot honestly carry a fifth system
  // prompt. A fifth means this file and the producer disagree about how many personas exist.
  it("accepts the four personas a round can carry", () => {
    const four = [0, 1, 2, 3].map((n) => request([systemMessage(`You are Katara, persona ${n}.`)]))

    expect(parseGameRound(four).warnings).toEqual([])
  })

  it("reports a fifth, and points at the persona set it disagrees with", () => {
    const five = [0, 1, 2, 3, 4].map((n) => request([systemMessage(`You are Katara, persona ${n}.`)]))
    const warnings = parseGameRound(five).warnings

    expect(warnings).toHaveLength(1)
    expect(at(warnings, 0).impact).toBe("inaccurate")
    expect(at(warnings, 0).message).toMatch(/carries 5 distinct system prompts, but Tapoo defines 4/)
    expect(at(warnings, 0).message).toMatch(/dmigwi\.github\.io\/tapoo\/prompts\.html/)
  })

  // Counted on the system prompt, not the user message: that one is the same fixed instruction on every
  // request - one checksum across all 32 in the snapshot - so it carries no persona to count.
  it("does not count the user message, which never changes", () => {
    const many = [0, 1, 2, 3, 4, 5].map((n) =>
      request([{role: "user", content: `Turn ${n}.`, content_checksum: sum(`Turn ${n}.`)}]),
    )

    expect(parseGameRound(many).warnings).toEqual([])
  })

  // A tool result is compacted rather than trimmed, so it neither hashes nor ends in an ellipsis.
  // traversalPayloadWarnings reconstructs those; treating them as prompts would warn on every log.
  it("leaves tool results to the reconstruction that can check them", () => {
    const warnings = parseGameRound([
      request([{role: "tool", content: '{"currentCell":[0,0]}', content_checksum: "0xdeadbeefdeadbeef"}]),
    ]).warnings

    expect(warnings).toEqual([])
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

  // typeof [] is "object", so the coercion this module used to carry reported a list as a record and
  // handed the reader a message whose every field was undefined. Consolidating on the shared asRecord,
  // which excludes arrays, is a behaviour change: an array where an object is expected now reads as
  // absent. Pinned here because it is the only behaviour this refactor altered.
  it("reads an array where a message object is expected as absent, not as a record", () => {
    // null, not an empty message: the two are read differently downstream - an empty message is a
    // response the model gave and said nothing in, and null is no assistant message in the payload.
    expect(assistantMessage({message: ["not", "a", "message"]})).toBeNull()
    expect(assistantMessage({choices: [{message: ["not", "a", "message"]}]})).toBeNull()
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
  it("reads Ollama's counts", () => {
    expect(responseUsage({prompt_eval_count: 3234, eval_count: 35, total_duration: 1_100_956_836, done_reason: "stop"}))
      .toEqual({promptTokens: 3234, completionTokens: 35, reasoningTokens: null,
        cachedPromptTokens: null, finishReason: "stop"})
  })

  // total_duration is in the payload above and is deliberately not read. It is throttled per request and
  // carries the test machine's network and load, so it is not the model's time and cannot compare one
  // run against another - and a number on the page invites exactly that comparison.
  it("does not read Ollama's wall-clock duration", () => {
    expect(responseUsage({total_duration: 1_100_956_836})).not.toHaveProperty("durationNs")
  })

  it("reads OpenAI's usage block, including the two a reasoning model adds", () => {
    expect(responseUsage({
      usage: {prompt_tokens: 3250, completion_tokens: 20, total_tokens: 3270,
        completion_tokens_details: {reasoning_tokens: 18}, prompt_tokens_details: {cached_tokens: 2304}},
      choices: [{finish_reason: "stop", message: {content: "x"}}],
    })).toEqual({promptTokens: 3250, completionTokens: 20, reasoningTokens: 18,
      cachedPromptTokens: 2304, finishReason: "stop"})
  })

  it("reads Anthropic's usage: output_tokens is the completion side, thinking included", () => {
    // Tapoo's adapter reads output_tokens alone and notes it already covers extended thinking, so the
    // two are not added together - that would double-count the thinking against the completion budget.
    expect(responseUsage({
      role: "assistant", stop_reason: "end_turn",
      usage: {input_tokens: 3100, output_tokens: 240, cache_read_input_tokens: 2048},
    })).toEqual({promptTokens: 3100, completionTokens: 240, reasoningTokens: null,
      cachedPromptTokens: 2048, finishReason: "end_turn"})
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
  })

  it("survives a payload that reports nothing at all", () => {
    for (const payload of [null, undefined, {}, "x", {usage: "no"}, {choices: []}]) {
      expect(responseUsage(payload)).toEqual({promptTokens: null, completionTokens: null,
        reasoningTokens: null, cachedPromptTokens: null, finishReason: null})
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
    const result = parse(envelope({entries: [
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
    const result = parse(envelope({entries: [response({choices: "not a list"})]}))

    expect(at(expectOk(result).warnings, 0).message).toMatch(/No prediction in this log was scored/)
  })

  it("stays quiet for a response that is readable but blank", () => {
    // A model stopping early is not a contract gap. Both real logs contain these - 46 and 3 of them -
    // and warning about them would cry wolf on every long run.
    const result = parse(envelope({entries: [
      response({message: {content: ""}, done_reason: "length"}),
      response({choices: [{finish_reason: "length", message: {content: ""}}]}),
    ]}))

    expect(expectOk(result).warnings).toEqual([])
  })

  it("stays quiet for a tool-only response", () => {
    const result = parse(envelope({entries: [
      response({message: {content: "", tool_calls: [{function: {name: "get_maze_structure"}}]}}),
    ]}))

    expect(expectOk(result).warnings).toEqual([])
  })
})
