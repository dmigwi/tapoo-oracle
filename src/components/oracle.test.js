import { beforeAll, describe, expect, it } from "vitest"

import {
  addReportTab,
  analyzeLogText,
  createInitialReportTabs,
  deleteReportTab,
  diagnosticRows,
  diagnosticTableData,
  groupResultTone,
  loadNewReportTabFromUrl,
  loadReportTabFromUrl,
  rubricQuestionRows,
  narrativeSummary,
  profileCards,
  provenanceRows,
  provenanceTableData,
  reportTabLabelFromUrl,
  trimReportTabLabel,
  validateOnlineJsonUrl,
} from "./oracle.js"

const fixtureUrl =
  "https://gist.githubusercontent.com/dmigwi/908ef03ef653fe39581f0756122ffe4c/raw/" +
  "9495b1c9b5c69f0c4276dd0d9ea1ae638be8db58/sample-agent-api-log.json"

let fixture
let fixtureText
let fixtureReport
let fixtureSource

beforeAll(async () => {
  let response
  try {
    response = await fetch(fixtureUrl, {signal: AbortSignal.timeout(10_000)})
  } catch (error) {
    console.warn(`Remote test fixture is unavailable: ${fixtureUrl}`)
    throw error
  }

  if (!response.ok) {
    console.warn(`Remote test fixture returned ${response.status}: ${fixtureUrl}`)
    throw new Error(`Could not load test fixture: ${response.status} ${response.statusText}`)
  }

  fixtureText = await response.text()
  fixture = JSON.parse(fixtureText)

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
    expect(result.warnings).toEqual([])
    expect(result.report.model).toBe("test-model")
    expect(result.report.capabilities).toHaveLength(9)
    expect(result.report.violations).toHaveLength(6)
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
    expect(result.error).toMatch(/^Not valid JSON:/)
  })

  // The previous analyzer accepted any JSON and inferred "events" from guessed key names, so an
  // unrelated payload produced a confident-looking profile of nothing. Rejecting non-Tapoo input is
  // the behavior that replaced it, and it is worth a test of its own.
  it("rejects JSON that is not a Tapoo export", () => {
    const result = analyzeLogText(JSON.stringify({ turns: [{ action: "move", status: "applied" }] }))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Not a Tapoo log export/)
  })

  it("surfaces contract warnings without refusing the log", () => {
    const result = analyzeLogText(JSON.stringify({ ...fixture, mode: "human" }))
    expect(result.ok).toBe(true)
    expect(result.warnings.join(" ")).toMatch(/not "agent-api"/)
  })

  it("retains the source URL when one is provided", () => {
    const result = analyzeLogText(fixtureText, {
      label: "sample-agent-api-log.json",
      sourceUrl: "https://example.com/logs/sample-agent-api-log.json",
    })

    expect(result.ok).toBe(true)
    expect(result.source.sourceUrl).toBe("https://example.com/logs/sample-agent-api-log.json")
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
    const state = {
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
    const state = {
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
    expect(first.result.ok).toBe(true)
    expect(next).toMatchObject({activeTabId: "first", isAdding: false, draftUrl: ""})
  })

  it("loads one existing tab without mutating other tabs", async () => {
    const state = {
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
    expect(first.result.ok).toBe(true)
    expect(second).toMatchObject({url: "https://example.com/second.json", status: "empty"})
  })

  it("stores load failures on the owning tab", async () => {
    const tabState = {
      tabs: [{id: "missing", url: "notaurl", label: "New report", status: "empty"}],
      activeTabId: "missing",
    }

    const next = await loadReportTabFromUrl(tabState, "missing", async () => fixtureText)
    expect(next.tabs[0]).toMatchObject({
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
    expect(cards[0]).toMatchObject({ label: "Capabilities demonstrated", value: "7/9" })
    expect(cards[1]).toMatchObject({ label: "Violations confirmed", value: "0/6" })

    // The rubric forbids collapsing the two into one score interval.
    expect(cards.map((card) => card.label)).not.toContain("Score")
  })

  it("shows every fact question with its answer and group result", () => {
    const rows = rubricQuestionRows(fixtureReport.capabilities)
    const structural = rows.filter((row) => row.id.startsWith("C7."))

    expect(structural).toHaveLength(2)
    expect(structural[0]).toMatchObject({id: "C7.Q1", answer: "NO", groupResult: "NO (1/2)"})
    expect(structural[0].question).toMatch(/corridor cells/)
    expect(structural[1]).toMatchObject({id: "C7.Q2", answer: "YES", groupResult: "NO (1/2)"})
  })

  it("provides one definition for every evaluated rubric answer", () => {
    for (const group of [...fixtureReport.capabilities, ...fixtureReport.violations]) {
      expect(Object.keys(group.questions)).toEqual(Object.keys(group.answers))
      expect(Object.values(group.questions).every((question) => question.length > 0)).toBe(true)
    }
  })

  it("marks endpoint failures as unscored", () => {
    const endpoint = diagnosticRows(fixtureReport).find((row) => row.signal === "Endpoint failures")
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

  it("describes provenance without inventing missing fields", () => {
    const rows = provenanceRows(fixtureSource, fixtureReport)
    expect(rows.find((row) => row.field === "Tapoo version").value).toBe("2.5.0")

    const withoutVersion = analyzeLogText(JSON.stringify({ ...fixture, version: undefined }))
    const missing = provenanceRows(withoutVersion.source, withoutVersion.report)
    expect(missing.find((row) => row.field === "Tapoo version").value).toBe("not recorded")
  })

  it("pivots provenance into one complete row", () => {
    const table = provenanceTableData(fixtureSource, fixtureReport)
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]).toMatchObject({
      "Tapoo version": "2.5.0",
      Model: "test-model",
      Player: "Blue",
    })
  })

  it("states what a negative answer does and does not mean", () => {
    const summary = narrativeSummary(fixtureReport)
    expect(summary).toMatch(/7 of 9 capabilities/)
    expect(summary).toMatch(/Trailblazer/)
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
