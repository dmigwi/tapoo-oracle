import { beforeAll, describe, expect, it } from "vitest"

import fixtureData from "./_snapshot_/tapoo-v2.5.1-gemma4-base-agent-api-log.json" with {type: "json"}
import {diagnosticRows, diagnosticTableData, modelOutputRows, groupResultTone, narrativeSummary, profileCards, provenanceRows, provenanceTableData, rubricQuestionRows, warningHeadline} from "./report-adapters"
import {addReportTab, analyzeLogText, createInitialReportTabs, deleteReportTab, loadNewReportTabFromUrl, loadReportTabFromUrl, reportTabLabelFromUrl, trimReportTabLabel} from "./report-tabs"
import {validateOnlineJsonUrl} from "./share-link"
import type {Report, ReportTabsState, TapooLog} from "./types"
import {at, expectErr, expectOk, messagesOf, must} from "./test-support";

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

  fixtureReport = result.report
  fixtureSource = result.source
})

describe("analyzeLogText", () => {
  it("analyzes a real Tapoo export", () => {
    const result = analyzeLogText(fixtureText, { label: "fixture" })

    expect(result.ok).toBe(true)
    expect(expectOk(result).warnings).toEqual([])
    expect(expectOk(result).report.model).toBe("gemma4")
    expect(expectOk(result).report.capabilities).toHaveLength(9)
    expect(expectOk(result).report.violations).toHaveLength(6)
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
    expect(reportTabLabelFromUrl("https://example.com/logs/tapoo%20run.json", 0)).toBe("tapoo run.json")
    expect(reportTabLabelFromUrl("https://example.com/logs/", 1)).toBe("logs")
    expect(reportTabLabelFromUrl("not a url", 2)).toBe("Report 3")
  })

  it("trims long report labels from the beginning", () => {
    expect(trimReportTabLabel("very-long-prefix-tapoo-agent-api-log.json", 27)).toBe("...tapoo-agent-api-log.json")
  })

  it("opens the add-report form without creating a report entry", () => {
    const state = createInitialReportTabs()
    const next = addReportTab(state, "report-fixed")

    expect(next.tabs).toHaveLength(0)
    expect(next.activeTabId).toBeNull()
    expect(next).toMatchObject({pendingTabId: "report-fixed", isAdding: true, draftUrl: ""})
  })

  it("deletes the active tab and selects the nearest remaining tab", () => {
    const state: ReportTabsState = {
      ...createInitialReportTabs(),
      tabs: [
        {id: "first", url: "https://example.com/first.json", label: "first.json", status: "loaded"},
        {id: "second", url: "https://example.com/second.json", label: "second.json", status: "loaded"},
        {id: "third", url: "https://example.com/third.json", label: "third.json", status: "loaded"},
      ],
      activeTabId: "second",
    }

    const next = deleteReportTab(state, "second")
    expect(next.tabs.map((tab) => tab.id)).toEqual(["first", "third"])
    expect(next.activeTabId).toBe("third")
  })

  it("returns to an empty report list after the last tab is deleted", () => {
    const state: ReportTabsState = {
      ...createInitialReportTabs(),
      tabs: [{id: "only", url: "https://example.com/only.json", label: "Only", status: "loaded"}],
      activeTabId: "only",
    }
    const next = deleteReportTab(state, "only", () => "replacement")

    expect(next).toMatchObject({tabs: [], activeTabId: null, isAdding: true})
    expect(next.pendingTabId).toBe("replacement")
  })

  it("loads a draft URL into a new report tab", async () => {
    let state = addReportTab(createInitialReportTabs(), "first")
    state = {...state, draftUrl: "https://example.com/first.json"}

    const next = await loadNewReportTabFromUrl(state, async () => fixtureText)
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
    const state: ReportTabsState = {
      ...createInitialReportTabs(),
      tabs: [
        {id: "first", url: "https://example.com/first.json", label: "first.json", status: "empty"},
        {id: "second", url: "https://example.com/second.json", label: "second.json", status: "empty"},
      ],
      activeTabId: "first",
    }

    const next = await loadReportTabFromUrl(state, "first", async () => fixtureText)
    const first = next.tabs.find((tab) => tab.id === "first")
    const second = next.tabs.find((tab) => tab.id === "second")

    expect(first).toMatchObject({label: "first.json", status: "loaded"})
    expect(must(must(first, "the loaded tab").result, "an analysis on the loaded tab").ok).toBe(true)
    expect(second).toMatchObject({url: "https://example.com/second.json", status: "empty"})
  })

  it("stores load failures on the owning tab", async () => {
    const tabState: ReportTabsState = {
      ...createInitialReportTabs(),
      tabs: [{id: "missing", url: "notaurl", label: "New report", status: "empty"}],
      activeTabId: "missing",
    }

    const next = await loadReportTabFromUrl(tabState, "missing", async () => fixtureText)
    expect(at(next.tabs, 0)).toMatchObject({
      status: "error",
      error: "Enter a valid URL.",
    })
  })

  it("stores draft load failures without creating a report entry", async () => {
    const state = {...addReportTab(createInitialReportTabs(), "missing"), draftUrl: "notaurl"}

    const next = await loadNewReportTabFromUrl(state, async () => fixtureText)
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

    // The rubric forbids collapsing the two into one score interval.
    expect(cards.map((card) => card.label)).not.toContain("Score")
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
    const endpoint = must(diagnosticRows(fixtureReport).find((row) => row.signal === "Endpoint failures"), "a matching row")
    expect(endpoint.scored).toBe("no")
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
    const rows = provenanceRows(fixtureSource, fixtureReport)

    // The one field here that the log does not vouch for, and a table cell is the most screenshotted
    // place on the page to print an address the rest of this change keeps out of it. The share link
    // on the panel identifies the same log.
    expect(rows.map((row) => row.field)).not.toContain("Source URL")
    expect(JSON.stringify(rows)).not.toContain("gist.githubusercontent.com")
  })

  it("describes provenance without inventing missing fields", () => {
    const rows = provenanceRows(fixtureSource, fixtureReport)
    expect(must(rows.find((row) => row.field === "Tapoo version"), "a matching row").value).toBe("2.5.1")

    const withoutVersion = analyzeLogText(JSON.stringify({ ...fixture, version: undefined }))
    const withoutVersionOk = expectOk(withoutVersion)
    const missing = provenanceRows(withoutVersionOk.source, withoutVersionOk.report)
    expect(must(missing.find((row) => row.field === "Tapoo version"), "a matching row").value).toBe("not recorded")
  })

  it("pivots provenance into one complete row", () => {
    const table = provenanceTableData(fixtureSource, fixtureReport)
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]).toMatchObject({
      "Tapoo version": "2.5.1",
      Model: "gemma4",
      Player: "Katara",
    })
  })

  it("states what a negative answer does and does not mean", () => {
    const summary = narrativeSummary(fixtureReport)
    expect(summary).toMatch(/5 of 9 capabilities/)
    expect(summary).toMatch(/Navigator/)
    expect(summary).toMatch(/not that the model is incapable/)
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
    ...expectOk(analyzeLogText(fixtureText, {label: "fixture"})).report,
    output: {responses: 0, promptTokens: null, completionTokens: null, reasoningTokens: null,
      cachedPromptTokens: null, durationNs: null, finishReasons: [], ...output},
  })

  const valueOf = (report: Report, field: string) =>
    modelOutputRows(report).find((row) => row.field === field)?.value

  it("gives a total and a per-response average, since a total only says how long the run was", () => {
    const report = reportWithOutput({responses: 4, promptTokens: 4000, completionTokens: 400})

    expect(valueOf(report, "Prompt tokens")).toBe("4,000 (1,000 per response)")
    expect(valueOf(report, "Completion tokens")).toBe("400 (100 per response)")
  })

  it("omits what a provider did not report, rather than printing a column of 'not recorded'", () => {
    // Ollama reports no reasoning or cached-token counts; OpenAI reports no duration.
    const ollama = reportWithOutput({responses: 2, promptTokens: 100, completionTokens: 20, durationNs: 4e9})

    expect(valueOf(ollama, "Reasoning tokens")).toBeUndefined()
    expect(valueOf(ollama, "Cached prompt tokens")).toBeUndefined()
    expect(valueOf(ollama, "Model time")).toBeDefined()
  })

  it("reads a long run the way a person would say it", () => {
    // One real log spent 19,174 seconds, which is five and a third hours and reads as neither.
    expect(valueOf(reportWithOutput({responses: 1, durationNs: 19_174e9}), "Model time"))
      .toBe("5h 20m (5h 20m per response)")
    expect(valueOf(reportWithOutput({responses: 1, durationNs: 154e9}), "Model time"))
      .toBe("2m 34s (2m 34s per response)")
    expect(valueOf(reportWithOutput({responses: 1, durationNs: 4.83e9}), "Model time"))
      .toBe("4.83s (4.83s per response)")
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
  it("reports the API provider and the reasoning effort", () => {
    const result = expectOk(analyzeLogText(fixtureText, {label: "fixture"}))
    const value = (field: string) =>
      provenanceRows(result.source, result.report).find((row) => row.field === field)?.value

    expect(value("API provider")).toBe("ollama")
    expect(value("Reasoning effort")).toBe("max")
  })
})
