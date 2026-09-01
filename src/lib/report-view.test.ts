/**
 * @vitest-environment jsdom
 */

import * as Inputs from "@observablehq/inputs"
import {html} from "htl"
import {describe, expect, it} from "vitest"

import {analyzeLogText, createInitialReportTabs} from "./report-tabs"
import {activeReportTab, renderReportSections} from "./report-view"
import type {LogEntry, Region, ReportTab, ReportTabsState} from "./types"
import {query, queryAll, rendered} from "./test-support";

// Driven against the real Inputs and the real htl, not stubs: this module's whole job is composing
// those two, and a stub would be testing the stub's shape rather than the one that ships.
const ui = {Inputs, html}

const REAL_MAZE = {
  index_chars: ["|", "---", "-", "   ", " ", "\n"],
  structure_checksum: "0x74af82cb14470b9d",
  structure:
    "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
  dimensions: {numCols: 6, numRows: 4, area: 24}
}

const entry = (payload: string, details?: unknown, turn = 0): LogEntry => ({
  epochMs: 1788000000000 + turn * 1000,
  time: "t",
  turn,
  level: 1,
  game: 2,
  log: "info",
  payload,
  details
})

const logExport = JSON.stringify({
  name: "tapoo",
  version: "2.5.1",
  mode: "agent-api",
  downloadedAt: "2026-08-30T21-00-00+02-00",
  entries: [
    entry("Agent level started.", {
      startPosition: {x: 1, y: 1},
      finalPosition: {x: 11, y: 1},
      destinationCell: {row: 0, col: 5},
      historyWindowRadius: 2,
      maze: REAL_MAZE
    }),
    entry(
      "Agent request.",
      {
        player: "Katara the Trailblazer - Default",
        tools: [{name: "get_maze_structure"}],
        messages: [
          {
            role: "tool",
            content: JSON.stringify({
              currentCell: [0, 0],
              filteredTraversalHistory: [
                {playerName: "Katara", cell: [0, 0], openMoves: [["MoveDown", "unvisited"]]}
              ]
            })
          }
        ]
      },
      1
    ),
    entry("Agent response.", {payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}}}, 1),
    entry("Agent level won.", {
      outcome: "won",
      traversalSpeed: "1.0000",
      agent: {playerName: "Katara"},
      playerPosition: {x: 1, y: 3},
      playerUniqueCellsVisited: 2,
      decayUnitsCharged: 2
    }, 2)
  ]
})

const loadedTab = (): ReportTab => {
  const result = analyzeLogText(logExport, {label: "gemma4.json"})
  expect(result.ok).toBe(true)
  return {id: "t1", url: "https://example.com/g.json", loadedUrl: "https://example.com/g.json",
    label: "gemma4.json", status: "loaded", result}
}

const stateWith = (...tabs: ReportTab[]): ReportTabsState =>
  ({...createInitialReportTabs(), tabs, activeTabId: tabs[0]?.id ?? null})
const text = (node: Region) => (node === "" ? "" : node.textContent ?? "")

describe("activeReportTab", () => {
  it("finds the tab the state marks active", () => {
    const first = {id: "a"} as ReportTab
    const second = {id: "b"} as ReportTab
    expect(activeReportTab({tabs: [first, second], activeTabId: "b"} as ReportTabsState)).toBe(second)
  })

  it("falls back to the first tab when the active id names none", () => {
    const first = {id: "a"} as ReportTab
    expect(activeReportTab({tabs: [first], activeTabId: "gone"} as ReportTabsState)).toBe(first)
  })

  it("survives a state that is not a tabs state at all", () => {
    expect(activeReportTab(undefined as unknown as ReportTabsState)).toBeUndefined()
    expect(activeReportTab({} as ReportTabsState)).toBeUndefined()
  })
})

describe("renderReportSections", () => {
  it("returns the five regions the page interpolates, in reading order", () => {
    const sections = renderReportSections(ui, stateWith(loadedTab()))
    expect(Object.keys(sections)).toEqual(["emptyState", "notices", "methodology", "profile", "detail"])
  })

  it("shows the how-to and nothing else before a report is loaded", () => {
    const sections = renderReportSections(ui, createInitialReportTabs())

    expect(text(sections.emptyState)).toMatch(/gist/i)
    // A page with no report must not render an empty profile shell around nothing.
    expect(sections.profile).toBe("")
    expect(sections.detail).toBe("")
    expect(sections.notices).toBe("")
    // Nor five stages of methodology above an empty state asking the reader to paste a URL.
    expect(sections.methodology).toBe("")
  })

  it("drops the how-to once a report is loaded", () => {
    const sections = renderReportSections(ui, stateWith(loadedTab()))
    expect(sections.emptyState).toBe("")
  })
})

describe("profile", () => {
  const profile = () => rendered(renderReportSections(ui, stateWith(loadedTab())).profile)

  it("names the log being analyzed", () => {
    expect(query(profile(), ".source-line").textContent).toMatch(/gemma4\.json/)
  })

  it("puts the maze between the source line and the metrics", () => {
    // The order is the point: the reader sees which log, then where the agent went, then the counts.
    // Asserted on the actual child sequence rather than on index arithmetic, which reads as passing
    // whenever a class is simply absent.
    const regions = [...profile().children].map((node) => node.className || node.tagName.toLowerCase())
    expect(regions).toEqual(["events-section", "analysis-strip", "events-section oracle-summary"])
  })

  it("renders the decoded maze, not a placeholder", () => {
    expect(profile().querySelector("svg.maze-grid")).not.toBeNull()
  })

  it("carries one metric card per headline figure", () => {
    const cards = profile().querySelectorAll(".analysis-strip .metric")
    expect(cards).toHaveLength(4)
    expect([...cards].map((card) => query(card, "span").textContent)).toContain(
      "Capabilities demonstrated"
    )
  })

  it("states what a negative answer means, in the summary", () => {
    expect(query(profile(), ".oracle-summary").textContent).toMatch(
      /not that the model is incapable/
    )
  })
})

describe("detail", () => {
  const detail = () => rendered(renderReportSections(ui, stateWith(loadedTab())).detail)

  it("leaves the methodology to its own region, so the page holds one copy", () => {
    expect(detail().querySelector(".methodology-section")).toBeNull()
  })

  it("renders every rubric section the report promises", () => {
    const headings = queryAll(detail(), "h2").map((node) => node.textContent)
    expect(headings).toEqual(
      expect.arrayContaining(["Capabilities", "Violations", "Operational Diagnostics", "Provenance"])
    )
  })

  it("builds the rubric tables through the real Inputs.table", () => {
    // prepareRubricTable and enableRowSelection both mutate a real table node; a hand-rolled table
    // would let either of them break while this stayed green.
    const rows = detail().querySelectorAll(".rubric-table tbody tr")
    expect(rows.length).toBeGreaterThan(0)
    expect(detail().querySelector(".rubric-table input[type=checkbox]")).not.toBeNull()
  })
})

describe("notices", () => {
  it("reports a tab that failed to load", () => {
    const tab: ReportTab = {id: "t1", url: "", label: "bad.json", status: "error", error: "404 Not Found"}
    const sections = renderReportSections(ui, stateWith(tab))

    expect(rendered(sections.notices).className).toBe("notice notice-error")
    expect(rendered(sections.notices).textContent).toMatch(/404 Not Found/)
    // A failed load has no report, so nothing downstream may render.
    expect(sections.profile).toBe("")
    expect(sections.detail).toBe("")
  })

  it("surfaces contract warnings without hiding the report they came with", () => {
    const result = analyzeLogText(logExport.replace('"agent-api"', '"human"'), {label: "g.json"})
    const sections = renderReportSections(ui, stateWith({...loadedTab(), result}))

    expect(rendered(sections.notices).className).toBe("notice notice-warn")
    expect(rendered(sections.notices).textContent).toMatch(/agent-api/)
    // The warning is a caveat on the report, not a replacement for it.
    expect(sections.profile).not.toBe("")
  })

  it("says nothing when a report loaded cleanly", () => {
    expect(renderReportSections(ui, stateWith(loadedTab())).notices).toBe("")
  })
})

describe("methodology", () => {
  const sectionsFor = (...tabs: ReportTab[]) => renderReportSections(ui, stateWith(...tabs))

  it("explains how the report was made, once a report exists to explain", () => {
    const section = rendered(sectionsFor(loadedTab()).methodology)

    expect(section.className).toContain("methodology-section")
    expect(query(section, ".methodology-title").textContent).toBe("How this report is generated")
    expect(queryAll(section, ".analysis-pipeline > li")).toHaveLength(5)
  })

  it("stays collapsed: it is reference material, not the report", () => {
    expect(rendered(sectionsFor(loadedTab()).methodology).tagName.toLowerCase()).toBe("details")
    expect(rendered(sectionsFor(loadedTab()).methodology).hasAttribute("open")).toBe(false)
  })

  it("renders nothing before a report is loaded", () => {
    // It used to be static markup in index.md, so an untouched page showed five stages describing the
    // treatment of evidence it did not have yet, directly above an empty state asking for a URL.
    expect(sectionsFor().methodology).toBe("")
    expect(renderReportSections(ui, createInitialReportTabs()).methodology).toBe("")
  })

  it("renders nothing for a tab that failed to load", () => {
    const tab: ReportTab = {id: "t1", url: "", label: "bad.json", status: "error", error: "404 Not Found"}

    expect(sectionsFor(tab).methodology).toBe("")
  })
})
