/**
 * @vitest-environment jsdom
 */

import * as Inputs from "@observablehq/inputs"
import {html} from "htl"
import {describe, expect, it} from "vitest"

import {createInitialLogTabs, roundReportFor} from "./log-tabs"
import {roundLabel} from "./rounds"
import {activeLogTab, activeRound, renderReportSections, stampBuildAge} from "./report-view"
import type {LogEntry, RegionView, LogTab, LogTabsState} from "./types"
import {analyzeLogText, query, queryAll, rendered} from "./test-support";

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

const twoRoundTab = (): LogTab => {
  const result = analyzeLogText(twoRoundExport, {label: "two-rounds.json"})
  expect(result.ok).toBe(true)
  return {id: "t2", url: "https://example.com/g.json", loadedUrl: "https://example.com/g.json",
    label: "two-rounds.json", status: "loaded", result}
}

const loadedTab = (): LogTab => {
  const result = analyzeLogText(logExport, {label: "gemma4.json"})
  expect(result.ok).toBe(true)
  return {id: "t1", url: "https://example.com/g.json", loadedUrl: "https://example.com/g.json",
    label: "gemma4.json", status: "loaded", result}
}

const stateWith = (...tabs: LogTab[]): LogTabsState =>
  ({...createInitialLogTabs(), tabs, activeTabId: tabs[0]?.id ?? null})
const text = (node: RegionView) => (node === "" ? "" : node.textContent ?? "")

describe("activeLogTab", () => {
  it("finds the tab the state marks active", () => {
    const first = {id: "a"} as LogTab
    const second = {id: "b"} as LogTab
    expect(activeLogTab({tabs: [first, second], activeTabId: "b"} as LogTabsState)).toBe(second)
  })

  it("falls back to the first tab when the active id names none", () => {
    const first = {id: "a"} as LogTab
    expect(activeLogTab({tabs: [first], activeTabId: "gone"} as LogTabsState)).toBe(first)
  })

  it("survives a state that is not a tabs state at all", () => {
    expect(activeLogTab(undefined as unknown as LogTabsState)).toBeUndefined()
    expect(activeLogTab({} as LogTabsState)).toBeUndefined()
  })
})

describe("renderReportSections", () => {
  it("returns the five regions the page interpolates, in reading order", () => {
    const sections = renderReportSections(ui, stateWith(loadedTab()))
    expect(Object.keys(sections)).toEqual(["emptyState", "notices", "methodology", "profile", "detail"])
  })

  it("shows the how-to and nothing else before a report is loaded", () => {
    const sections = renderReportSections(ui, createInitialLogTabs())

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

  // The note went footer -> hero -> here. Its order is the point: what file, which game, how it was
  // processed, then the replay - so it is asserted on the actual sequence rather than on presence.
  it("says how the log was processed, between the game identity and the replay", () => {
    const node = profile()
    const order = [...query(node, ".events-section").children].map((child) => child.className)

    expect(order).toEqual(["source-line", "round-identity", "processing-note", "maze-replay"])
    expect(query(node, ".processing-note").textContent).toMatch(/analyzed in your browser/)
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

// Both branches of the round lookup, which nothing exercised directly: the render only ever reaches it
// with null on the first pass and an identity the tabs just drew on the second.
describe("activeRound", () => {
  const labelOf = (round: ReturnType<typeof activeRound>) =>
    round === undefined ? undefined : roundLabel(round.identity)

  it("takes the first round when nothing is selected", () => {
    expect(labelOf(activeRound(twoRoundTab(), null))).toBe("Game 2 \u00b7 Level 1")
  })

  it("takes the round an identity names", () => {
    expect(labelOf(activeRound(twoRoundTab(), {game: 3, level: 2}))).toBe("Game 3 \u00b7 Level 2")
  })

  // An identity can only come from a round tab this module drew, so one that matches nothing means the
  // tabs and the analysis have gone out of step - a bug here, not anything a reader did. It used to
  // fall back to the first round, which looked entirely correct and said nothing about having been
  // asked for another.
  it("throws on an identity naming no round, rather than quietly showing the first", () => {
    expect(() => activeRound(twoRoundTab(), {game: 99, level: 99})).toThrow(/no round 99\/99/)
  })

  it("has no round for a tab that carries no report", () => {
    expect(activeRound(undefined, null)).toBeUndefined()
    expect(activeRound({id: "x", url: "u", label: "l", status: "empty"}, null)).toBeUndefined()
  })
})

// The other half of the split: opening a log does not answer every round in it.
describe("when a round is answered", () => {
  const rounds = (tab: LogTab) => {
    const result = tab.result
    if (!result?.ok) throw new Error("fixture did not analyze")
    return result.rounds
  }

  // A slice is entries and an identity. Nothing in it is a verdict, so building one costs no rubric
  // pass - which is what lets a fourteen-round file open at the price of one.
  it("carries unanswered slices out of the parse", () => {
    const slices = rounds(twoRoundTab())

    expect(slices.map((slice) => roundLabel(slice.identity))).toEqual(["Game 2 \u00b7 Level 1", "Game 3 \u00b7 Level 2"])
    for (const slice of slices) {
      expect(slice).not.toHaveProperty("report")
      expect(slice.entries.length).toBeGreaterThan(0)
    }
  })

  // Memoized on the slice, so returning to a round is free and the view holds a stable object across
  // renders rather than a fresh report on every scrub.
  it("answers a round once, however often it is asked for", () => {
    const [first, second] = rounds(twoRoundTab())
    if (!first || !second) throw new Error("expected two rounds")

    expect(roundReportFor(first)).toBe(roundReportFor(first))
    expect(roundReportFor(second)).not.toBe(roundReportFor(first))
  })

  // And the answer is the round's own: verdicts built from that round's entries, caveats from that
  // round's payloads.
  it("answers each round from its own entries", () => {
    const [first, second] = rounds(twoRoundTab())
    if (!first || !second) throw new Error("expected two rounds")

    expect(roundReportFor(first).report.levels).toHaveLength(1)
    expect(roundReportFor(first).report.label).toMatch(/Game 2 \u00b7 Level 1$/)
    expect(roundReportFor(second).report.label).toMatch(/Game 3 \u00b7 Level 2$/)
  })
})

// The whole point of the parser split: a caveat about one round is shown with that round and nowhere
// else, while a caveat about the file is shown whatever is open.
describe("where a warning is attributed", () => {
  // Round 2 carries a get_maze_structure result whose content no longer matches the checksum stamped on
  // it. Round 1 carries nothing of the kind, so it has no caveat of its own.
  //
  // A damaged *maze* would not do: that is reported by the replay, in the space the traversal should
  // have occupied, and deliberately not repeated here. A payload that fails its checksum has no such
  // home - the maze still draws, and draws visit colours the log cannot vouch for.
  const damagedSecondRound = (): LogTab => {
    const parsed = JSON.parse(twoRoundExport) as {entries: Array<Record<string, unknown>>}
    const started = parsed.entries.filter((e) => e.payload === "Agent level started.")
    const second = started[1]
    if (!second) throw new Error("fixture has no second round")
    // The reconstruction only runs when the round stated how far the agent could see.
    second.details = {...(second.details as object), historyWindowRadius: 2}

    parsed.entries.push({
      ...entry("Agent request.", {
        messages: [{
          role: "tool",
          content: JSON.stringify({
            currentCell: {row: 1, col: 1},
            filteredTraversalHistory: [{playerName: "Katara", cell: {row: 1, col: 1}, openMoves: {}}],
          }),
          content_checksum: "0xdeadbeefdeadbeef",
        }],
      }, 6),
      game: 3,
      level: 2,
    })

    const result = analyzeLogText(JSON.stringify(parsed), {label: "two-rounds.json"})
    expect(result.ok).toBe(true)
    return {id: "t3", url: "https://example.com/g.json", loadedUrl: "https://example.com/g.json",
      label: "two-rounds.json", status: "loaded", result}
  }

  const mount = (tab: LogTab) => {
    const sections = renderReportSections(ui, stateWith(tab))
    const host = document.createElement("div")
    for (const region of [sections.notices, sections.profile, sections.detail]) {
      if (region !== "") host.append(region)
    }
    document.body.append(host)
    return host
  }

  it("says nothing about the damaged round while the sound one is open", () => {
    const host = mount(damagedSecondRound())

    expect(query(host, ".round-tab-active").textContent).toBe("Game 2 \u00b7 Level 1")
    expect(host.textContent).not.toMatch(/does not match its checksum/)
  })

  it("says it once that round is opened, and names the round", () => {
    const host = mount(damagedSecondRound())
    queryAll<HTMLButtonElement>(host, ".round-tab")[1]?.click()

    expect(query(host, ".round-tab-active").textContent).toBe("Game 3 \u00b7 Level 2")
    expect(host.textContent).toMatch(/does not match its checksum/)
    expect(query(host, ".notice-round-label").textContent).toBe("Game 3 \u00b7 Level 2")

    // Under the tabs that select it, not up with the log's own caveats. Above them a reader met the
    // round's name before knowing there were rounds to choose between.
    const tabs = query(host, ".round-tabs")
    const notice = query(host, ".notice-round")
    expect(tabs.parentElement).toBe(notice.parentElement)
    expect(tabs.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // And back again: the notice has to move with the round, or it keeps naming the one the page opened
  // on - the same attribution bug in a smaller place.
  it("takes the round's caveat away again when the reader leaves it", () => {
    const host = mount(damagedSecondRound())
    queryAll<HTMLButtonElement>(host, ".round-tab")[1]?.click()
    queryAll<HTMLButtonElement>(host, ".round-tab")[0]?.click()

    expect(host.textContent).not.toMatch(/does not match its checksum/)
  })
})

// The validation summary reaches the page, at both scopes and labelled by scope.
describe("payload validation", () => {
  const detail = (tab: LogTab) => rendered(renderReportSections(ui, stateWith(tab)).detail)

  // One table, no grouping. A reader has already chosen which round they are reading, from the tabs
  // above; a second grouping under that choice reads as a second choice to make. The two checks that
  // cover the whole file are marked instead, and a footnote says what the mark means.
  it("lists every check in one table, marking the ones that cover the file", () => {
    const node = detail(loadedTab())
    const section = [...node.querySelectorAll("section")].find(
      (candidate) => candidate.querySelector("h2")?.textContent === "Payload validation",
    )
    if (!section) throw new Error("no payload validation section")
    const names = [...section.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()).filter(Boolean)[0],
    )

    expect(section.querySelectorAll(".validation-scope")).toHaveLength(0)
    expect(names).toEqual([
      "Log entry fields*",
      "Model responses*",
      "Encoded maze",
      "Prompts and tool descriptions",
      "Tool descriptions",
      "Agent personas",
      "Traversal payloads",
    ])
    expect(section.textContent).toMatch(/Checked once over the whole log file, so it holds for every round/)
  })

  // Provenance used to be one row of eight columns, which trimmed its own values on a narrow viewport.
  // Two columns down the page, like Model Output directly above it.
  it("renders provenance as field and value rows", () => {
    const node = detail(loadedTab())
    const headers = queryAll<HTMLElement>(node, "thead th").map((th) => th.textContent?.trim())

    expect(headers).toContain("MEASURE")
    expect(headers).toContain("VALUE")
    expect(headers).toContain("CHECK")
    expect(headers).toContain("RESULT")
    // Eight provenance fields, each on its own row rather than each in its own column.
    expect(headers).not.toContain("Tapoo version")
  })
})

describe("round tabs", () => {
  // Regions are attached to a document: selecting a round replaces them in place, and replaceWith
  // needs a parent. A detached render would pass every assertion below and do nothing on the page.
  const mount = (tab: LogTab) => {
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

  // A click on the tab already selected is ignored, because re-rendering the round on screen rebuilds
  // the maze replay: the scrubber goes back to the end and the magnifier switches off. A reader who
  // clicks where they already are should keep their place.
  it("ignores a click on the round already showing", () => {
    const host = mount(twoRoundTab())
    const before = query(host, ".maze-replay")
    const scrubber = query<HTMLInputElement>(host, 'input[type="range"]')
    scrubber.value = "1"
    scrubber.dispatchEvent(new window.Event("input", {bubbles: true}))

    queryAll<HTMLButtonElement>(host, ".round-tab")[0]?.click()

    expect(query(host, ".maze-replay")).toBe(before)
    expect(query<HTMLInputElement>(host, 'input[type="range"]').value).toBe("1")
  })

  // The guard is only safe while the key it compares against is the round actually on screen, and that
  // key comes from one callback the render fires. Nothing about `key === activeKey` says so, and the
  // ways it can rot are silent in both directions: a callback that never fires leaves the key null, so
  // the guard never matches and every click rebuilds; a key set from the click instead of the render
  // leaves it naming a round that is not drawn, so the guard matches the wrong one and swallows a real
  // switch.
  //
  // So this asserts the invariant rather than either symptom - for every round: clicking it draws it,
  // and clicking it again does nothing. A guard that has stopped tracking fails one half or the other.
  it("draws the round clicked, and redraws nothing when it is clicked again", () => {
    const host = mount(twoRoundTab())
    const labels = queryAll<HTMLElement>(host, ".round-tab").map((button) => button.textContent)
    expect(labels).toHaveLength(2)

    for (const label of labels) {
      const tab = queryAll<HTMLButtonElement>(host, ".round-tab").find((b) => b.textContent === label)
      tab?.click()

      // What was asked for is what is drawn - the premise the tracked key depends on.
      expect(query(host, ".round-tab-active").textContent).toBe(label)

      const drawn = query(host, ".maze-replay")
      queryAll<HTMLButtonElement>(host, ".round-tab").find((b) => b.textContent === label)?.click()
      expect(query(host, ".maze-replay")).toBe(drawn)
      expect(query(host, ".round-tab-active").textContent).toBe(label)
    }
  })

  // And a click on a different round still works, which is what the guard must not break.
  it("still switches to a round that is not showing", () => {
    const host = mount(twoRoundTab())
    const before = query(host, ".maze-replay")

    queryAll<HTMLButtonElement>(host, ".round-tab")[1]?.click()

    expect(query(host, ".maze-replay")).not.toBe(before)
    expect(query(host, ".round-tab-active").textContent).toBe("Game 3 \u00b7 Level 2")
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
    const tab: LogTab = {id: "t1", url: "", label: "bad.json", status: "error", error: "404 Not Found"}
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
  const sectionsFor = (...tabs: LogTab[]) => renderReportSections(ui, stateWith(...tabs))

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
    expect(renderReportSections(ui, createInitialLogTabs()).methodology).toBe("")
  })

  it("renders nothing for a tab that failed to load", () => {
    const tab: LogTab = {id: "t1", url: "", label: "bad.json", status: "error", error: "404 Not Found"}

    expect(sectionsFor(tab).methodology).toBe("")
  })
})

const footer = (html: string): HTMLElement => {
  const root = document.createElement("footer")
  root.innerHTML = html
  document.body.append(root)
  return root
}

const NOW = new Date("2026-09-06T12:00:00Z")

describe("stampBuildAge", () => {
  it("finishes the build stamp with how long ago it was", () => {
    const root = footer('<time datetime="2026-09-03T12:00:00Z" data-build-age>2026-09-03</time>')

    stampBuildAge(root, NOW)

    expect(root.textContent).toBe("2026-09-03 (3 days ago)")
  })

  // A re-render must not stack a second parenthetical onto the first.
  it("replaces the age rather than appending another", () => {
    const root = footer('<time datetime="2026-09-03T12:00:00Z" data-build-age>2026-09-03</time>')

    stampBuildAge(root, NOW)
    stampBuildAge(root, new Date("2026-09-06T13:00:00Z"))

    expect(root.querySelectorAll(".build-age")).toHaveLength(1)
    expect(root.textContent).toBe("2026-09-03 (3 days ago)")
  })

  // A footer decoration must never take the page down with it: the date already in the HTML is true and
  // useful on its own, and everything here is an improvement on that rather than a requirement.
  it("does nothing when there is no stamp to finish", () => {
    const root = footer("<span>no stamp here</span>")

    expect(() => stampBuildAge(root, NOW)).not.toThrow()
    expect(root.textContent).toBe("no stamp here")
  })

  it("does nothing when the stamp carries an unreadable instant", () => {
    const root = footer('<time datetime="the other day" data-build-age>whenever</time>')

    stampBuildAge(root, NOW)

    expect(root.textContent).toBe("whenever")
  })
})
