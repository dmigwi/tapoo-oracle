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

// A second round in the same export: a different game and level, its own maze, its own outcome. What
// the round tabs exist for.
const twoRoundExport = JSON.stringify({
  ...JSON.parse(logExport) as Record<string, unknown>,
  entries: [
    ...(JSON.parse(logExport) as {entries: LogEntry[]}).entries,
    {...entry("Agent level started.", {
      startPosition: {x: 1, y: 1},
      destinationCell: {row: 0, col: 5},
      maze: REAL_MAZE
    }, 3), game: 3, level: 2},
    {...entry("Agent response.", {payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}}}, 4), game: 3, level: 2},
    {...entry("Agent level lost.", {outcome: "lost", agent: {playerName: "Katara"},
      playerPosition: {x: 1, y: 1}, playerUniqueCellsVisited: 1, decayUnitsCharged: 1}, 5), game: 3, level: 2},
  ]
})

const twoRoundTab = (): ReportTab => {
  const result = analyzeLogText(twoRoundExport, {label: "two-rounds.json"})
  expect(result.ok).toBe(true)
  return {id: "t2", url: "https://example.com/g.json", loadedUrl: "https://example.com/g.json",
    label: "two-rounds.json", status: "loaded", result}
}

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

  it("puts the maze above the profile, and the metrics inside it", () => {
    // The order is the point: the reader sees which log, then where the agent went, then the profile.
    // Asserted on the actual child sequence rather than on index arithmetic, which reads as passing
    // whenever a class is simply absent.
    const regions = [...profile().children].map((node) => node.className || node.tagName.toLowerCase())
    expect(regions).toEqual(["events-section", "events-section oracle-summary"])
  })

  it("keeps the metric strip inside the profile it summarises, under the prose", () => {
    // The strip used to be a section of its own between the maze and the profile, which read as three
    // unrelated blocks. It belongs to the Behavior Profile: same section, after the sentence, so the
    // cards are the figures for the paragraph above them rather than a floating row of numbers.
    const summary = query(profile(), ".oracle-summary")
    expect(summary.querySelector(".analysis-strip")).not.toBeNull()

    const order = [...summary.children].map((node) => node.className || node.tagName.toLowerCase())
    expect(order).toEqual(["h2", "p", "analysis-strip"])
  })

  // A row of codes looks informative and is not: the reader has to carry them to the rubric tables to
  // learn what was demonstrated. The names have to be on the card, in the open - not behind a hover,
  // which does not exist on touch and which nothing about a code invites.
  it("spells out every group it counted, keeping the code for cross-reference", () => {
    const detail = queryAll<HTMLElement>(profile(), ".metric-detail")
    expect(detail.length).toBeGreaterThan(0)

    const node = profile()
    const codes = queryAll<HTMLElement>(node, ".metric-detail .rubric-code")
    expect(codes.length).toBeGreaterThan(0)
    expect(codes.every((code) => /^[CV]\d+$/.test(code.textContent ?? ""))).toBe(true)

    // Words, not just codes: a card whose names went missing would still match the codes above.
    const names = detail
      .map((region) => region.textContent ?? "")
      .join(" ")
      .replace(/[CV]\d+|\u00b7|\s+/g, " ")
    expect(names.trim().length).toBeGreaterThan(20)
    expect(node.querySelector(".metric-detail abbr")).toBeNull()
  })

  // One appearance, reserved for identifiers, so a reader can find a cross-reference by its shape.
  // The rubric table's own ID column has to wear it too, or the code on the card and the code that
  // defines it look like different kinds of thing.
  it("gives every rubric identifier the same reserved treatment", () => {
    expect(queryAll(profile(), ".metric-detail .rubric-code").length).toBeGreaterThan(0)

    const rows = rendered(renderReportSections(ui, stateWith(loadedTab())).detail)
    const inTable = queryAll<HTMLElement>(rows, ".rubric-table .rubric-code")
    expect(inTable.length).toBeGreaterThan(0)
    // The same element and the same class as on the card - not a cell styled to resemble one.
    expect(inTable.every((code) => code.tagName === "SPAN")).toBe(true)
    expect(inTable.every((code) => /^[CV]\d+\.Q\d+$/.test(code.textContent ?? ""))).toBe(true)
  })

  // One group per line, so the codes stack into a column down the left edge. What this can assert is
  // the structure that makes that possible - one element per group, each opening with its code. That
  // the element is a block is a stylesheet fact, and no stylesheet is loaded here.
  it("wraps each group in its own element, opening with the code", () => {
    const groups = queryAll<HTMLElement>(profile(), ".metric-detail .metric-group")
    expect(groups.length).toBeGreaterThan(1)
    expect(groups.every((group) => group.firstElementChild?.className === "rubric-code")).toBe(true)

    // The line break is what separates the groups now, so a leftover middot would read as noise on the
    // end of a line.
    expect(profile().querySelector(".metric-sep")).toBeNull()
    expect(queryAll<HTMLElement>(profile(), ".metric-detail")
      .every((detail) => !(detail.textContent ?? "").includes("\u00b7"))).toBe(true)
  })

  it("renders the decoded maze, not a placeholder", () => {
    expect(profile().querySelector("svg.maze-grid")).not.toBeNull()
  })

  it("carries one metric card per headline figure", () => {
    const cards = profile().querySelectorAll(".analysis-strip .metric")
    // Two fractions and nothing else. "Rounds" left when a report became per-round: it could only ever
    // read 1, and it existed to warn that the verdicts were blended across mazes.
    expect(cards).toHaveLength(2)
    // The label now carries its group ids inline, so match the start rather than the whole string.
    expect([...cards].map((card) => query(card, "span").textContent)).toEqual([
      expect.stringMatching(/^Capabilities demonstrated/),
      expect.stringMatching(/^Violations confirmed/),
    ])
  })

  // One page, one explanation of what a NO means: the methodology section. The summary and the hero
  // lede used to carry copies of it, and three statements of one rule read as three hedges.
  it("leaves what a negative answer means to the methodology section", () => {
    const sections = renderReportSections(ui, stateWith(loadedTab()))
    expect(text(sections.profile)).not.toMatch(/not that the model is incapable/)
    expect(text(sections.methodology)).toMatch(/not that the model is incapable/)
  })
})

describe("round tabs", () => {
  // Regions are attached to a document: selecting a round replaces them in place, and replaceWith
  // needs a parent. A detached render would pass every assertion below and do nothing on the page.
  const mount = (tab: ReportTab) => {
    const sections = renderReportSections(ui, stateWith(tab))
    const host = document.createElement("div")
    for (const region of [sections.profile, sections.detail]) {
      if (region !== "") host.append(region)
    }
    document.body.append(host)
    return host
  }
  const labels = (node: ParentNode) =>
    queryAll<HTMLElement>(node, ".round-tab").map((button) => button.textContent ?? "")

  it("names each game identity the log recorded, in play order", () => {
    expect(labels(mount(twoRoundTab()))).toEqual(["Game 2 \u00b7 Level 1", "Game 3 \u00b7 Level 2"])
  })

  // A tablist of one is not a choice, but the identity still has to be visible - it is what the
  // verdicts below are about.
  it("states the identity on its own line when there is only one round", () => {
    const node = mount(loadedTab())
    expect(labels(node)).toEqual([])
    expect(query(node, ".round-identity").textContent).toBe("Game 2 \u00b7 Level 1")
  })

  it("opens on the first round", () => {
    expect(query(mount(twoRoundTab()), ".round-tab-active").textContent).toBe("Game 2 \u00b7 Level 1")
  })

  // The whole point: the verdicts, the maze and the metric cards move together. A click that swapped
  // the replay and left the rubric behind would put one round's answers over another round's maze.
  it("swaps the profile and the detail together when a round is clicked", () => {
    const host = mount(twoRoundTab())
    const before = host.textContent ?? ""

    queryAll<HTMLButtonElement>(host, ".round-tab")[1]?.click()

    expect(query(host, ".round-tab-active").textContent).toBe("Game 3 \u00b7 Level 2")
    expect(host.textContent).not.toBe(before)
    // Both regions, not just the one holding the tabs.
    expect(queryAll(host, ".rubric-table").length).toBeGreaterThan(0)
  })

  it("switches back, so a round is never a one-way door", () => {
    const host = mount(twoRoundTab())
    queryAll<HTMLButtonElement>(host, ".round-tab")[1]?.click()
    queryAll<HTMLButtonElement>(host, ".round-tab")[0]?.click()
    expect(query(host, ".round-tab-active").textContent).toBe("Game 2 \u00b7 Level 1")
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

  // Which cells are identifiers comes from the data, not from what the text looks like. An unscored
  // signal prints "no" and must stay plain: a rule that read the characters would be right about this
  // one by luck and wrong the day the id scheme changes.
  it("chips only the cells the data says are identifiers", () => {
    const chips = queryAll<HTMLElement>(detail(), ".rubric-code").map((code) => code.textContent)
    expect(chips.length).toBeGreaterThan(0)
    expect(chips).toContain("V2.Q2")
    expect(chips).not.toContain("no")

    // The count cells share a column with the scoring cells and are never identifiers.
    expect(chips.every((text) => /^[CV]\d+\.Q\d+$/.test(text ?? ""))).toBe(true)
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
    // The cost is stated in bold before the caveat explains it: a reader who reads nothing else should
    // still know the report below is not to be quoted as it stands.
    expect(query(rendered(sections.notices), "strong").textContent).toBe("This report may be inaccurate.")
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
