import { beforeAll, describe, expect, it } from "vitest"

import fixtureData from "./_snapshot_/tapoo-v2.5.1-gemma4-base-agent-api-log.json" with {type: "json"}
import {diagnosticRows, diagnosticTableData, modelOutputRows, groupResultTone, narrativeSummary, profileCards, agentRows, provenanceRows, withoutCredentials, rubricQuestionRows, warningHeadline} from "./report-adapters"
import {addLogTab, createInitialLogTabs, deleteLogTab, loadNewLogTabFromUrl, loadLogTabFromUrl, logTabLabelFromUrl, trimLogTabLabel} from "./log-tabs"
import {validateOnlineJsonUrl} from "./share-link"
import type {Report, LogTabsState, TapooLog} from "./types"
import {analyzeLogText, at, expectErr, expectOk, firstRound, messagesOf, must} from "./test-support";

// Vendored from the fixed-revision gemma4 Gist supplied for contract validation. Keeping the bytes
// local makes the suite deterministic while preserving the complete Tapoo 2.5.1 payload.
let fixture: Record<string, unknown>
let fixtureText: string
let fixtureReport: Report
let fixtureSource: TapooLog

beforeAll(() => {
  fixtureText = JSON.stringify(fixtureData)
  fixture = JSON.parse(fixtureText) as Record<string, unknown>

  const result = analyzeLogText(fixtureText, {label: "fixture"})
  if (!result.ok) {
    throw new Error(`Remote test fixture is not analyzable: ${result.error}`)
  }

  fixtureReport = firstRound(result)
  fixtureSource = result.source
})

describe("analyzeLogText", () => {
  it("analyzes a real Tapoo export", () => {
    const result = analyzeLogText(fixtureText, { label: "fixture" })

    expect(result.ok).toBe(true)
    expect(expectOk(result).warnings).toEqual([])
    // One report per round, each carrying the full rubric. The fixture is a single-round log, so the
    // count is 1 - a multi-round log is what the round tabs exist for.
    expect(expectOk(result).rounds).toHaveLength(1)
    // The declared name, not the "gemma4" the provider echoed back: an echo drops the ":cloud" saying
    // where the model was served from, and that is the half a reader comparing two runs needs.
    expect(firstRound(result).agents.map((agent) => agent.models)).toEqual([["gemma4:cloud"]])
    expect(firstRound(result).capabilities).toHaveLength(9)
    expect(firstRound(result).violations).toHaveLength(6)
  })

  it("explains an empty input rather than failing silently", () => {
    expect(analyzeLogText("   ")).toEqual({
      ok: false,
      error: "Load a Tapoo agent-api log from an online JSON URL to begin.",
    })
  })

  it("reports malformed JSON", () => {
    const result = analyzeLogText("{not json")
    expect(result.ok).toBe(false)
    expect(expectErr(result).error).toMatch(/^Not valid JSON:/)
  })

  // The previous analyzer accepted any JSON and inferred "events" from guessed key names, so an
  // unrelated payload produced a confident-looking profile of nothing. Rejecting non-Tapoo input is
  // the behavior that replaced it, and it is worth a test of its own.
  it("rejects JSON that is not a Tapoo export", () => {
    const result = analyzeLogText(JSON.stringify({ turns: [{ action: "move", status: "applied" }] }))
    expect(result.ok).toBe(false)
    expect(expectErr(result).error).toMatch(/Not a Tapoo log export/)
  })

  it("surfaces contract warnings without refusing the log", () => {
    const result = analyzeLogText(JSON.stringify({ ...fixture, mode: "human" }))
    expect(result.ok).toBe(true)
    expect(messagesOf(expectOk(result).warnings).join(" ")).toMatch(/not "agent-api"/)
  })

  it("retains the source URL when one is provided", () => {
    const result = analyzeLogText(fixtureText, {
      label: "sample-agent-api-log.json",
      sourceUrl: "https://example.com/logs/sample-agent-api-log.json",
    })

    expect(result.ok).toBe(true)
    expect(expectOk(result).source.sourceUrl).toBe("https://example.com/logs/sample-agent-api-log.json")
  })
})

describe("report URL tabs", () => {
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

  it("derives readable report labels from URLs", () => {
    expect(logTabLabelFromUrl("https://example.com/logs/tapoo%20run.json", 0)).toBe("tapoo run.json")
    expect(logTabLabelFromUrl("https://example.com/logs/", 1)).toBe("logs")
    expect(logTabLabelFromUrl("not a url", 2)).toBe("Report 3")
  })

  it("trims long report labels from the beginning", () => {
    expect(trimLogTabLabel("very-long-prefix-tapoo-agent-api-log.json", 27)).toBe("...tapoo-agent-api-log.json")
  })

  it("opens the add-report form without creating a report entry", () => {
    const state = createInitialLogTabs()
    const next = addLogTab(state, "report-fixed")

    expect(next.tabs).toHaveLength(0)
    expect(next.activeTabId).toBeNull()
    expect(next).toMatchObject({pendingTabId: "report-fixed", isAdding: true, draftUrl: ""})
  })

  it("deletes the active tab and selects the nearest remaining tab", () => {
    const state: LogTabsState = {
      ...createInitialLogTabs(),
      tabs: [
        {id: "first", url: "https://example.com/first.json", label: "first.json", status: "loaded"},
        {id: "second", url: "https://example.com/second.json", label: "second.json", status: "loaded"},
        {id: "third", url: "https://example.com/third.json", label: "third.json", status: "loaded"},
      ],
      activeTabId: "second",
    }

    const next = deleteLogTab(state, "second")
    expect(next.tabs.map((tab) => tab.id)).toEqual(["first", "third"])
    expect(next.activeTabId).toBe("third")
  })

  it("returns to an empty report list after the last tab is deleted", () => {
    const state: LogTabsState = {
      ...createInitialLogTabs(),
      tabs: [{id: "only", url: "https://example.com/only.json", label: "Only", status: "loaded"}],
      activeTabId: "only",
    }
    const next = deleteLogTab(state, "only", () => "replacement")

    expect(next).toMatchObject({tabs: [], activeTabId: null, isAdding: true})
    expect(next.pendingTabId).toBe("replacement")
  })

  // The invariant the type now states: a parsed log always yields at least one round, so nothing
  // downstream has to render around "loaded, but no rounds". A log that names no round at all still
  // gets one holding everything.
  it("always yields at least one round", () => {
    const result = analyzeLogText(fixtureText, {label: "fixture"})

    expect(expectOk(result).rounds.length).toBeGreaterThan(0)
    expect(expectOk(analyzeLogText(JSON.stringify({
      name: "tapoo",
      version: "2.5.1",
      mode: "agent-api",
      entries: [{epochMs: 1, time: "t", log: "info", payload: "Agent request.", details: {}}],
    }))).rounds).toHaveLength(1)
  })

  it("loads a draft URL into a new log tab", async () => {
    let state = addLogTab(createInitialLogTabs(), "first")
    state = {...state, draftUrl: "https://example.com/first.json"}

    const next = await loadNewLogTabFromUrl(state, async () => fixtureText)
    const first = next.tabs.find((tab) => tab.id === "first")

    expect(first).toMatchObject({
      label: "first.json",
      status: "loaded",
      loadedUrl: "https://example.com/first.json",
    })
    expect(must(must(first, "the loaded tab").result, "an analysis on the loaded tab").ok).toBe(true)
    expect(next).toMatchObject({activeTabId: "first", isAdding: false, draftUrl: ""})
  })

  it("loads one existing tab without mutating other tabs", async () => {
    const state: LogTabsState = {
      ...createInitialLogTabs(),
      tabs: [
        {id: "first", url: "https://example.com/first.json", label: "first.json", status: "empty"},
        {id: "second", url: "https://example.com/second.json", label: "second.json", status: "empty"},
      ],
      activeTabId: "first",
    }

    const next = await loadLogTabFromUrl(state, "first", async () => fixtureText)
    const first = next.tabs.find((tab) => tab.id === "first")
    const second = next.tabs.find((tab) => tab.id === "second")

    expect(first).toMatchObject({label: "first.json", status: "loaded"})
    expect(must(must(first, "the loaded tab").result, "an analysis on the loaded tab").ok).toBe(true)
    expect(second).toMatchObject({url: "https://example.com/second.json", status: "empty"})
  })

  it("stores load failures on the owning tab", async () => {
    const tabState: LogTabsState = {
      ...createInitialLogTabs(),
      tabs: [{id: "missing", url: "notaurl", label: "New report", status: "empty"}],
      activeTabId: "missing",
    }

    const next = await loadLogTabFromUrl(tabState, "missing", async () => fixtureText)
    expect(at(next.tabs, 0)).toMatchObject({
      status: "error",
      error: "Enter a valid URL.",
    })
  })

  it("stores draft load failures without creating a report entry", async () => {
    const state = {...addLogTab(createInitialLogTabs(), "missing"), draftUrl: "notaurl"}

    const next = await loadNewLogTabFromUrl(state, async () => fixtureText)
    expect(next).toMatchObject({
      tabs: [],
      isAdding: true,
      draftStatus: "error",
      draftError: "Enter a valid URL.",
    })
  })
})

describe("presentation", () => {
  it("keeps capabilities and violations as separate fractions", () => {
    const cards = profileCards(fixtureReport)
    expect(at(cards, 0)).toMatchObject({ label: "Capabilities demonstrated", value: "5/9" })
    expect(at(cards, 1)).toMatchObject({ label: "Violations confirmed", value: "2/6" })

    // The groups behind each fraction, on the card that states it - not several words away in prose.
    // Counted, so the ids and the numerator can never disagree about what was met.
    expect(at(cards, 0).groups).toHaveLength(5)
    expect(at(cards, 1).groups).toHaveLength(2)
    expect(at(cards, 0).groups.map((group) => group.id).every((id) => id.startsWith("C"))).toBe(true)
    expect(at(cards, 1).groups.map((group) => group.id).every((id) => id.startsWith("V"))).toBe(true)
    // Each code carries the name it stands for, so "C6" can be read where it appears.
    expect(at(cards, 0).groups.every((group) => group.label.length > 0)).toBe(true)

    // The rubric forbids collapsing the two into one score interval.
    expect(cards.map((card) => card.label)).not.toContain("Score")
  })

  // "Violations confirmed (none) 0/6" states the same zero three times, so the parenthetical is simply
  // absent and the fraction carries it alone.
  it("lists no groups when none were met", () => {
    const none = profileCards({...fixtureReport, capabilities: [], violations: []})
    expect(none.map((card) => card.groups)).toEqual([[], []])
    expect(none.map((card) => card.value)).toEqual(["0/0", "0/0"])
  })

  it("shows every fact question with its answer and group result", () => {
    const rows = rubricQuestionRows(fixtureReport.capabilities)
    const structural = rows.filter((row) => row.id?.startsWith("C7.") ?? false)

    expect(structural).toHaveLength(2)
    expect(at(structural, 0)).toMatchObject({id: "C7.Q1", answer: "NO", groupResult: "NO (0/2)"})
    expect(at(structural, 0).question).toMatch(/corridor cells/)
    expect(at(structural, 1)).toMatchObject({id: "C7.Q2", answer: "NO", groupResult: "NO (0/2)"})
  })

  it("provides one definition for every evaluated rubric answer", () => {
    for (const group of [...fixtureReport.capabilities, ...fixtureReport.violations]) {
      expect(Object.keys(group.questions)).toEqual(Object.keys(group.answers))
      expect(Object.values(group.questions).every((question) => question.length > 0)).toBe(true)
    }
  })

  it("marks endpoint failures as unscored", () => {
    const rows = diagnosticRows(fixtureReport)
    const find = (signal: string) => must(rows.find((row) => row.signal === signal), `the ${signal} row`)

    // Null rather than the word "no": nothing scores an endpoint failure, and the table decides how to
    // print that. A display string here would put "no" and "V2.Q2" in one field, leaving the view to
    // tell a code from a word by looking at its characters.
    expect(find("Endpoint failures").scoredBy).toBeNull()
    expect(find("Empty responses").scoredBy).toBe("V2.Q2")
  })

  it("pivots diagnostics into count and scoring rows", () => {
    const table = diagnosticTableData(fixtureReport)
    expect(table.columns).toEqual([
      "measure",
      "Endpoint failures",
      "Empty responses",
      "Unparseable responses",
      "Token cap exhaustions",
    ])
    expect(table.rows[0]).toMatchObject({measure: "Count", "Endpoint failures": 0})
    expect(table.rows[1]).toMatchObject({measure: "Scored as", "Endpoint failures": "no"})
  })

  it("keeps the log address out of provenance", () => {
    const rows = provenanceRows(fixtureSource)

    // The one field here that the log does not vouch for, and a table cell is the most screenshotted
    // place on the page to print an address the rest of this change keeps out of it. The share link
    // on the panel identifies the same log.
    expect(rows.map((row) => row.field)).not.toContain("Source URL")
    expect(JSON.stringify(rows)).not.toContain("gist.githubusercontent.com")
  })

  it("describes provenance without inventing missing fields", () => {
    const rows = provenanceRows(fixtureSource)
    expect(must(rows.find((row) => row.field === "Tapoo version"), "a matching row").value).toBe("2.5.1")

    const withoutVersion = analyzeLogText(JSON.stringify({ ...fixture, version: undefined }))
    const withoutVersionOk = expectOk(withoutVersion)
    const missing = provenanceRows(withoutVersionOk.source)
    expect(must(missing.find((row) => row.field === "Tapoo version"), "a matching row").value).toBe("not recorded")
  })


  it("says only what no card and no table already says", () => {
    const summary = narrativeSummary(fixtureReport)

    expect(summary).toMatch(/predictions?\./)
    expect(summary).toMatch(/Navigator/)
    // The fraction is on the cards directly beneath, and the setup is on the Agents table - which can
    // say which seat ran which, where a single sentence had to pick one.
    expect(summary).not.toMatch(/of 9 capabilities/)
    expect(summary).not.toMatch(/reasoning effort/)
    expect(summary).not.toMatch(/\(C\d/)
    // What a NO means is explained once, in "How this report is generated".
    expect(summary).not.toMatch(/not that the model is incapable/)
  })
})

// YES means opposite things in the two rubric tables, so the colour cannot be chosen from the value
// alone. These pin that, and pin the rows that must stay uncoloured.
describe("groupResultTone", () => {
  it("colours a demonstrated capability with the capability tone", () => {
    expect(groupResultTone("capability", "YES (3/3)")).toBe("result-demonstrated")
  })

  it("colours a confirmed violation with the violation tone", () => {
    expect(groupResultTone("violation", "YES (1/3)")).toBe("result-confirmed")
  })

  it("leaves an unconfirmed violation uncoloured, because NO is its good outcome", () => {
    expect(groupResultTone("violation", "NO (0/3)")).toBeNull()
  })

  it("leaves an undemonstrated capability uncoloured", () => {
    // A capability answering NO means the behavior was not observed in this sample, never that the
    // model is incapable of it. Red here would state exactly what the report refuses to state.
    expect(groupResultTone("capability", "NO (1/2)")).toBeNull()
  })

  it("reads the verdict from the start of the value, not from anywhere in it", () => {
    // "NO (0/1)" contains no YES, but a fraction or label that happened to could otherwise flip the
    // colour of a row that was never confirmed.
    expect(groupResultTone("capability", "NO (0/1) YES")).toBeNull()
  })
})

describe("warningHeadline", () => {
  // A warning is only shown when it costs the reader something, so the banner names that cost instead
  // of asking them to infer it. The old heading was "Read with care", which is a tone rather than a
  // finding - a reader could not tell from it whether a verdict below was wrong or whether the report
  // was merely missing its provenance.
  const inaccurate = {impact: "inaccurate", message: "x"} as const
  const incomplete = {impact: "incomplete", message: "y"} as const

  it("says a verdict may be wrong when one may be", () => {
    expect(warningHeadline([inaccurate])).toBe("This report may be inaccurate.")
  })

  it("says what is missing when nothing is wrong, only absent", () => {
    expect(warningHeadline([incomplete])).toBe("This report is missing important parts.")
  })

  it("reports both harms rather than collapsing them into the louder one", () => {
    expect(warningHeadline([incomplete, inaccurate]))
      .toBe("This report may be inaccurate and is missing important parts.")
  })

  it("says nothing when there is nothing to say", () => {
    expect(warningHeadline([])).toBeNull()
  })

  it("classifies the caveats a real log produces", () => {
    // A non-agent-api round is answered by questions written for a different mode, so the verdicts may
    // be wrong; a missing build version leaves every verdict standing but unattributable.
    const wrongMode = analyzeLogText(JSON.stringify({...fixture, mode: "human"}))
    expect(expectOk(wrongMode).warnings.map((w) => w.impact)).toContain("inaccurate")
    expect(warningHeadline(expectOk(wrongMode).warnings))
      .toBe("This report may be inaccurate.")

    const noVersion = analyzeLogText(JSON.stringify({...fixture, version: undefined}))
    expect(expectOk(noVersion).warnings.every((w) => w.impact === "incomplete")).toBe(true)
    expect(warningHeadline(expectOk(noVersion).warnings)).toBe("This report is missing important parts.")
  })
})

describe("modelOutputRows", () => {
  // What the provider said about its own work, normalized across two API shapes that report
  // overlapping but different things. Not scored - it is context for reading the verdicts.
  const reportWithOutput = (output: Partial<Report["output"]>): Report => ({
    ...firstRound(analyzeLogText(fixtureText, {label: "fixture"})),
    output: {responses: 0, promptTokens: null, completionTokens: null, reasoningTokens: null,
      cachedPromptTokens: null, finishReasons: [], ...output},
  })

  const valueOf = (report: Report, field: string) =>
    modelOutputRows(report).find((row) => row.field === field)?.value

  it("gives a total and a per-response average, since a total only says how long the run was", () => {
    const report = reportWithOutput({responses: 4, promptTokens: 4000, completionTokens: 400})

    expect(valueOf(report, "Prompt tokens")).toBe("4,000 (1,000 per response)")
    expect(valueOf(report, "Completion tokens")).toBe("400 (100 per response)")
  })

  it("omits what a provider did not report, rather than printing a column of 'not recorded'", () => {
    // Ollama reports no reasoning or cached-token counts.
    const ollama = reportWithOutput({responses: 2, promptTokens: 100, completionTokens: 20})

    expect(valueOf(ollama, "Reasoning tokens")).toBeUndefined()
    expect(valueOf(ollama, "Cached prompt tokens")).toBeUndefined()
  })

  // Wall-clock time is not reported at all. Ollama's total_duration is throttled per request and carries
  // the machine's network and load, so it says nothing about the model - and a row showing it would be
  // read as a speed comparison between runs, which is the one thing it cannot support.
  it("reports no wall-clock time", () => {
    const rows = modelOutputRows(reportWithOutput({responses: 4, promptTokens: 4000}))

    expect(rows.map((row) => row.field)).not.toContain("Model time")
    expect(rows.some((row) => /time|duration/i.test(row.field))).toBe(false)
  })

  it("names every finish reason with its count, including the rare one", () => {
    // "length" appearing at all means the model was cut off mid-answer, and that is worth seeing even
    // when it happened three times in 719.
    const report = reportWithOutput({responses: 719, finishReasons: [["tool_calls", 359], ["stop", 357], ["length", 3]]})

    expect(valueOf(report, "Finish reasons")).toBe("tool_calls (359), stop (357), length (3)")
  })

  it("still says how many responses there were when nothing else was reported", () => {
    expect(modelOutputRows(reportWithOutput({responses: 1}))).toEqual([{field: "Responses", value: "1"}])
  })
})

describe("provenance names the setup a verdict depends on", () => {
  // The endpoint is an address, and this file already keeps one out of the DOM. This one is wanted - a
  // reader cannot compare two runs without knowing where each was answered - but credentials in it are
  // not, and validateOnlineJsonUrl already refuses them on the way in.
  it("prints an endpoint without its credentials", () => {
    expect(withoutCredentials("http://user:pass@host:11434/api/chat")).toBe("http://host:11434/api/chat")
    expect(withoutCredentials("http://localhost:11434/api/chat")).toBe("http://localhost:11434/api/chat")
    // Not a URL the constructor accepts: there is no userinfo to strip, so it passes through.
    expect(withoutCredentials("not an address")).toBe("not an address")
  })

  it("keeps credentials out of the rendered agent row", () => {
    const rows = agentRows([{
      name: "Katara", seatId: 1, models: ["gemma4"], apis: ["ollama"],
      endpoints: ["http://user:pass@host/api"], reasoningEfforts: ["max"],
      uniqueCells: null, decayCharged: null, traversalSpeed: null,
    }])

    expect(rows[0]?.value).not.toMatch(/user:pass/)
    expect(rows[0]?.value).toMatch(/http:\/\/host\/api/)
  })

  // Provenance carries only what belongs to the file and the round. The provider and the effort moved
  // to the Agents table, where they belong to a seat: a round can seat two agents on two providers, and
  // one row could only ever name one of them.
  it("names each seat's provider and effort on the seat, not on the round", () => {
    const result = expectOk(analyzeLogText(fixtureText, {label: "fixture"}))
    const fields = provenanceRows(result.source).map((row) => row.field)

    expect(fields).toEqual(["Tapoo version", "Control mode", "Downloaded at", "Log entries"])
    // Seat 1 because the log says so, on the round-end record - the only place v2.5.1 states a seat.
    // Without reading it the label would fall back to acting order, which happens to agree here and so
    // would hide the field being ignored.
    expect(firstRound(result).agents.map((agent) => agent.seatId)).toEqual([1])
    expect(agentRows(firstRound(result).agents)).toEqual([
      {
        field: "Katara \u00b7 Agent at Seat 1",
        value: "gemma4:cloud through Ollama (http://localhost:11434/api/chat) at max reasoning effort",
        // The same four values unjoined, which is what the table actually renders - the sentence is the
        // fallback for anything that cannot weight them.
        running: {
          models: "gemma4:cloud",
          provider: "Ollama",
          endpoint: "http://localhost:11434/api/chat",
          effort: "max",
        },
      },
    ])
  })
})
