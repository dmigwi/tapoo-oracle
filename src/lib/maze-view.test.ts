/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest"

import {turnReports} from "./log-contract"
import {createMazeReplay} from "./maze-view"
import {agentsFromRound} from "./rounds"
import type {CellKey, EncodedMaze, Move, Outcome, PlayedRound, TurnSummary, VisitStatus} from "./types"
import {at, query, queryAll} from "./test-support";

const REAL_MAZE = {
  index_chars: ["|", "---", "-", "   ", " ", "\n"],
  structure_checksum: "0x74af82cb14470b9d",
  structure:
    "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
  dimensions: { numCols: 6, numRows: 4, area: 24 },
}

type RoundOverrides = {encodedMaze?: EncodedMaze | null; game?: number; lvl?: number}

const TURNS: TurnSummary[] = [
  { turn: 0, seatId: null, playerName: "Katara", before: "0,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: null },
  { turn: 1, seatId: null, playerName: "Katara", before: "1,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, decayCharged: null },
  {
    turn: 2,
    seatId: null,
    playerName: "Katara",
    before: "2,0",
    moves: ["MoveRight", "MoveUp"] as Move[], submittedCount: 2,
    applied: 1,
    cells: ["2,0", "2,1"],
    rejectedMove: "MoveUp", decayCharged: null,
  },
]

const OUTCOME: Outcome = {
  outcome: "won", traversalSpeed: "1.0000", playerUniqueCellsVisited: 17, decayUnitsCharged: 17,
}

const level = ({encodedMaze = REAL_MAZE, game = 2, lvl = 1}: RoundOverrides = {}): PlayedRound => ({
  identity: {game, level: lvl},
  encodedMaze,
  startCell: "0,0",
  startPosition: null,
  historyWindowRadius: null,
  // A resolved cell key: buildPlayedRounds reads the logged shape - which may be {row, col} or
  // [row, col] - through the contract, so a level model never carries the raw form.
  destinationCell: "0,5",
  endCell: "2,1",
  observedExits: new Map(),
  visitStatusAfterTurn: turnReports<Map<CellKey, VisitStatus>>(),
  positions: [],
  turns: TURNS,
  outcome: OUTCOME,
  // Derived the way buildPlayedRounds derives it, so the panels below are rendering the real parser's output.
  agents: agentsFromRound(new Map(), TURNS, OUTCOME),
})

// The round on its own, which is what the page hands the replay.
const build = (round: PlayedRound | null) => createMazeReplay(round)

const range = (node: ParentNode) => query<HTMLInputElement>(node, "input[type=range]")
const caption = (node: ParentNode) => query(node, ".maze-caption").textContent
const overlayCircles = (node: ParentNode) => queryAll(node, ".maze-overlay circle")

// Driven through the real input element and a real input event, not by calling the paint function:
// a scrubber that never repaints on input would pass every assertion made against the function alone.
const scrubTo = (node: ParentNode, value: number) => {
  const input = range(node)
  input.value = String(value)
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
}

describe("createMazeReplay", () => {
  it("draws the decoded maze with one wall group and an overlay", () => {
    const node = build(level())

    expect(node.querySelector("svg.maze-grid")).not.toBeNull()
    expect(node.querySelector(".maze-overlay")).not.toBeNull()
    // 24 cells with walls on every closed edge, so a real grid always has lines.
    expect(node.querySelectorAll("svg line").length).toBeGreaterThan(20)
  })

  it("opens at the end of the round", () => {
    const node = build(level())

    // The control's own coordinate is a position, 0..n. What it *shows* is the log's turn number, the
    // same identifier the caption and the bar tooltips use - the fixture's three turns are 0, 1, 2.
    expect(range(node).value).toBe("3")
    expect(query(node, ".maze-readout").textContent).toBe("Turn 2 / 2")
  })

  // The whole point of the change: three surfaces, one number. Parsed from both rather than hardcoded,
  // so they cannot drift apart again without this failing.
  it("names the same turn in the readout, the caption and the bar tooltip", () => {
    const node = build(level())

    for (const position of [1, 2, 3]) {
      scrubTo(node, position)
      const readout = /Turn (\d+) \//.exec(query(node, ".maze-readout").textContent ?? "")?.[1]
      const captioned = /^Turn (\d+)/.exec(caption(node))?.[1]
      const tooltip = /^Turn (\d+):/.exec(
        queryAll<HTMLElement>(node, ".maze-bars-moves .maze-bar")[position - 1]?.title ?? "",
      )?.[1]

      expect(readout).toBeDefined()
      expect(captioned).toBe(readout)
      expect(tooltip).toBe(readout)
    }
  })

  it("repaints when the scrubber moves", () => {
    const node = build(level())

    scrubTo(node, 0)
    expect(caption(node)).toMatch(/Start position/)
    // Before any turn there is no turn to name, so the readout says so rather than printing a number
    // for a frame that has none.
    expect(query(node, ".maze-readout").textContent).toBe("Start")
    // No agent has acted yet, so no position marker is drawn.
    expect(overlayCircles(node)).toHaveLength(0)

    scrubTo(node, 1)
    // Short now: the bars carry the shape of the round, and a single-agent round does not repeat
    // the agent's name on every frame.
    expect(caption(node)).toBe("Turn 0 \u00b7 1 of 1 applied")
    expect(overlayCircles(node)).toHaveLength(1)
  })

  // The refusal is named in the caption and shown on the bars, and not drawn on the grid: a bar whose
  // green share falls short of its height is a turn that asked for more than it got, and that reads across
  // the whole run rather than only on the turn you have scrubbed to.
  it("names the refused move on the turn that produced it, without marking the grid", () => {
    const node = build(level())

    scrubTo(node, 3)
    expect(caption(node)).toBe("Turn 2 \u00b7 1 of 2 applied \u00b7 MoveUp refused")
    expect(range(node).getAttribute("aria-valuetext")).toMatch(/MoveUp refused/)

    // The grid draws no mark for the refusal. It was a cross on the wall the move was aimed through,
    // and the bar strip now carries the same fact across every turn rather than only the scrubbed one:
    // a bar whose green share falls short of its height is a turn that asked for more than it got.
    expect(queryAll(node, ".maze-overlay line")).toHaveLength(0)

    // Nor on any other turn, scrubbed or not.
    scrubTo(node, 2)
    expect(queryAll(node, ".maze-overlay line")).toHaveLength(0)
  })

  it("reports a maze it cannot trust instead of drawing one", () => {
    const node = build(level({ encodedMaze: { ...REAL_MAZE, structure: `${REAL_MAZE.structure}0` } }))

    expect(node.querySelector("svg.maze-grid")).toBeNull()
    expect(query(node, ".notice-error").textContent).toMatch(/checksum/)
    expect(query(node, ".maze-scrubber").hidden).toBe(true)
  })

  it("renders nothing for a report that answered no round", () => {
    expect(build(null).querySelector("svg")).toBeNull()
  })
})

describe("start and destination markers", () => {
  // Both were drawn with a helper that takes an element name and an attribute bag, so naming one
  // element and passing another's attributes type-checks, renders, and is invisible: a <rect> given
  // cx/cy/r ignores all three and defaults to 0x0. It is in the DOM and zero pixels on screen, so
  // asserting the node exists proves nothing. These assert the geometry.
  const markers = (node: ParentNode) =>
    queryAll<SVGRectElement>(node, "svg.maze-grid > rect")
      .map((rect) => ({
        width: Number(rect.getAttribute("width")),
        height: Number(rect.getAttribute("height")),
        fill: rect.getAttribute("fill"),
      }))

  it("draws both markers at a size a reader can see", () => {
    const drawn = markers(build(level()))

    expect(drawn).toHaveLength(2)
    for (const marker of drawn) {
      expect(marker.width).toBeGreaterThan(0)
      expect(marker.height).toBeGreaterThan(0)
    }
  })

  it("tells them apart by size, not only by colour", () => {
    // Rose against muted is the one pairing a red-green colour deficiency cannot separate, and the two
    // marks mean opposite things on the same grid.
    const [first, second] = markers(build(level()))

    expect(first?.width).not.toBe(second?.width)
  })

  it("paints the landmarks above the trail, not under it", () => {
    // SVG has no z-index - paint order is document order. The start cell is in frame.visited from
    // frame 0 by construction and the visited tint is a full-cell opaque rect, so markers drawn before
    // the overlay were buried at every frame while looking perfectly correct in the DOM.
    const svg = query(build(level()), "svg.maze-grid")
    const children = [...svg.children]
    const overlay = children.findIndex((child) => child.classList.contains("maze-overlay"))
    const firstMarker = children.findIndex((child) => child.tagName === "rect")

    expect(overlay).toBeGreaterThanOrEqual(0)
    expect(firstMarker).toBeGreaterThan(overlay)
  })

  it("keeps the start marker visible on the frame that covers its cell", () => {
    // Frame 0 already tints the start cell. This is the case that was broken.
    const node = build(level())
    scrubTo(node, 0)
    const svg = query(node, "svg.maze-grid")
    const children = [...svg.children]
    const overlay = children.findIndex((child) => child.classList.contains("maze-overlay"))

    expect(queryAll<SVGRectElement>(svg, ":scope > rect")).toHaveLength(2)
    expect(children.findIndex((child) => child.tagName === "rect")).toBeGreaterThan(overlay)
  })

  it("draws neither when the round records no start or destination", () => {
    const bare = {...level(), startCell: null, destinationCell: null}

    expect(markers(build(bare))).toHaveLength(0)
  })
})

describe("the bars beside the scrubber", () => {
  const bars = (node: ParentNode, which: "moves" | "decay") =>
    queryAll<HTMLElement>(node, `.maze-bars-${which} .maze-bar`)

  // A round where the last turn's charge was never reported - the ordinary case, since no turn follows
  // the last one to report it.
  const charged = (...values: Array<number | null>) => {
    const base = level()
    return {...base, turns: base.turns.map((turn, index) => ({...turn, decayCharged: values[index] ?? null}))}
  }

  it("draws one bar per turn in each strip", () => {
    const node = build(charged(1, 2, 1))

    expect(bars(node, "moves")).toHaveLength(3)
    expect(bars(node, "decay")).toHaveLength(3)
  })

  it("sizes a moves bar by what was submitted, against the round's own maximum", () => {
    // Turn 2 submits two moves and the others one, so it is the tallest and sets the scale.
    //
    // Square root, not linear: these distributions are long-tailed, and in a real round one turn
    // submitting twelve moves squashed the 261 turns that submitted one down to 2px of a 24px strip.
    const heights = bars(build(level()), "moves").map((bar) => Math.round(parseFloat(bar.style.height)))

    expect(heights).toEqual([71, 71, 100])
  })

  it("fills the applied share and leaves the rest", () => {
    // Turn 2 submitted two and landed one, which is the whole point of the green: the ungreened part
    // is exactly what the agent asked for and did not get.
    const shares = bars(build(level()), "moves").map((bar) => bar.style.getPropertyValue("--applied"))

    expect(shares).toEqual(["100%", "100%", "50%"])
  })

  it("names each turn on the bar, so a sliver is still readable", () => {
    // At 464 turns a bar is under two pixels wide; the title is the only way to read one.
    expect(at(bars(build(level()), "moves"), 2).title).toBe("Turn 2: 1 of 2 applied")
  })

  it("distinguishes an unreported applied count from zero", () => {
    const unknown = level()
    unknown.turns[0]!.applied = null
    const bar = at(bars(build(unknown), "moves"), 0)

    expect(bar.classList.contains("is-unknown")).toBe(true)
    expect(bar.title).toBe("Turn 0: applied moves not reported")
  })

  it("separates the bars where there is room, and closes the gap where there is not", () => {
    // At 464 turns a 2px gap would take 463px of an 830px strip and leave each bar under a pixel - a
    // separation that erases what it is meant to separate.
    const many = (count: number) => {
      const base = level()
      const turn = at(base.turns, 0)
      return {...base, turns: Array.from({length: count}, (_, index) => ({...turn, turn: index}))}
    }

    expect(query(build(many(16)), ".maze-bars-moves").style.gap).toBe("2px")
    expect(query(build(many(150)), ".maze-bars-moves").style.gap).toBe("1px")
    expect(query(build(many(464)), ".maze-bars-moves").style.gap).toBe("0px")
  })

  it("marks the scrubbed turn in both strips", () => {
    const node = build(charged(1, 2, 1))
    scrubTo(node, 2)

    expect(bars(node, "moves").map((bar) => bar.classList.contains("is-current")))
      .toEqual([false, true, false])
    expect(bars(node, "decay").map((bar) => bar.classList.contains("is-current")))
      .toEqual([false, true, false])
  })

  it("fades the turns the scrubber has not reached, the way the slider fades its track", () => {
    // All three layers then read as one control: left of the thumb has happened, right of it has not.
    const node = build(charged(1, 2, 1))
    scrubTo(node, 1)

    expect(bars(node, "moves").map((bar) => bar.classList.contains("is-future")))
      .toEqual([false, true, true])
    expect(bars(node, "decay").map((bar) => bar.classList.contains("is-future")))
      .toEqual([false, true, true])
  })

  it("fades nothing once the scrubber is at the end", () => {
    const node = build(charged(1, 2, 1))
    scrubTo(node, 3)

    expect(bars(node, "moves").some((bar) => bar.classList.contains("is-future"))).toBe(false)
  })

  it("tracks how far along the slider is, so its own fill matches the strips", () => {
    const node = build(charged(1, 2, 1))
    scrubTo(node, 1)

    expect(query<HTMLInputElement>(node, "input[type=range]").style.getPropertyValue("--progress"))
      .toBe(`${(1 / 3) * 100}%`)
  })

  it("marks nothing at the start position, which is no turn at all", () => {
    const node = build(level())
    scrubTo(node, 0)

    expect(bars(node, "moves").some((bar) => bar.classList.contains("is-current"))).toBe(false)
  })

  it("draws an unreported charge as unknown, not as zero", () => {
    // A cost nothing recorded is not a cost of nothing, and a flat bar would claim the turn was free.
    const node = build(charged(1, 2, null))
    const unknown = bars(node, "decay").filter((bar) => bar.classList.contains("is-unknown"))

    expect(unknown).toHaveLength(1)
    expect(at(unknown, 0).style.height).toBe("100%")
    expect(at(bars(node, "decay"), 2).title).toBe("Turn 2: decay not reported")
  })

  it("hides the decay strip when the round reports no charge at all", () => {
    // An agent that never called get_last_prediction_outcome - the case C3.Q3 exists to detect - gets
    // no strip rather than a band of unknowns.
    const node = build(level())

    expect(query(node, ".maze-bars-decay").hidden).toBe(true)
  })

  it("shows the decay strip and scales it once charges are reported", () => {
    const node = build(charged(1, 1, 4))

    expect(query(node, ".maze-bars-decay").hidden).toBe(false)
  })

  it("draws the three charges at different heights, and colours what each one means", () => {
    // Height is how much it cost, colour is what it was for. Both, because a height alone cannot say
    // whether two units were a wall or a broken response.
    const decay = bars(build(charged(1, 2, 3)), "decay")

    expect(decay.map((bar) => Math.round(parseFloat(bar.style.height)))).toEqual([33, 67, 100])
    expect(decay.map((bar) => [...bar.classList].find((name) => name.startsWith("is-decay-"))))
      .toEqual(["is-decay-1", "is-decay-2", "is-decay-3"])
  })

  it("reads decay on an absolute scale, so a cheap round looks cheap", () => {
    // Scaled to the round, a run that only ever paid the base rate drew every bar full height - the
    // cheapest possible round rendered as the most expensive one.
    const allBase = bars(build(charged(1, 1, 1)), "decay")

    expect(allBase.map((bar) => Math.round(parseFloat(bar.style.height)))).toEqual([33, 33, 33])
  })

  it("tells the three charging states apart by colour", () => {
    const classes = bars(build(charged(1, 2, 3)), "decay")
      .map((bar) => [...bar.classList].find((name) => name.startsWith("is-decay-")))

    expect(classes).toEqual(["is-decay-1", "is-decay-2", "is-decay-3"])
  })

  it("names why each turn was charged, and marks the severity", () => {
    // Every turn pays a base unit; an invalid move costs two; a broken response format costs three.
    const node = build(charged(1, 2, 3))
    const decay = bars(node, "decay")

    expect(decay.map((bar) => bar.title)).toEqual([
      "Turn 0: 1 decay - base charge",
      "Turn 1: 2 decay - invalid move",
      "Turn 2: 3 decay - output format violation",
    ])
    expect(decay.map((bar) => [...bar.classList].find((name) => name.startsWith("is-decay-"))))
      .toEqual(["is-decay-1", "is-decay-2", "is-decay-3"])
  })
})

// The overlay is the feature: a cell's colour has to say how heavily it was worked, and it has to change
// as the scrubber moves.
describe("visit status on the grid", () => {
  const statusesOf = (node: ParentNode) =>
    queryAll<SVGRectElement>(node, ".maze-overlay rect.maze-cell").map(
      (rect) => [...rect.classList].find((name) => name.startsWith("is-")) ?? "",
    )

  // Fixtures name the turn that CARRIED each payload, the way a log does; the store applies the offset.
  const statusLevel = (byReportingTurn: Array<[number, Array<[string, string]>]>) => {
    const reports = turnReports<Map<CellKey, VisitStatus>>()
    for (const [reportingTurn, cells] of byReportingTurn) {
      reports.record(reportingTurn, new Map(cells as Array<[CellKey, VisitStatus]>))
    }
    return {...level(), visitStatusAfterTurn: reports}
  }

  it("classes each visited cell by the status the log gave it", () => {
    const node = build(statusLevel([[1, [["0,0", "oscillating"]]]]))
    scrubTo(node, 1)
    expect(statusesOf(node)).toContain("is-oscillating")
  })

  // A cell nobody entered has no rect at all, so the paper shows through - which is what "unvisited"
  // looks like, and why the scale needs no fill for it.
  it("draws nothing for a cell that was never entered", () => {
    const node = build(level())
    scrubTo(node, 1)
    // The 4x6 maze has 24 cells; only the walked ones are painted.
    expect(statusesOf(node).length).toBeLessThan(24)
  })

  it("re-derives the classes when the scrubber moves", () => {
    const node = build(statusLevel([[1, [["0,0", "explored"]]], [3, [["0,0", "oscillating"]]]]))

    scrubTo(node, 1)
    expect(statusesOf(node)).toContain("is-explored")
    expect(statusesOf(node)).not.toContain("is-oscillating")

    scrubTo(node, 3)
    expect(statusesOf(node)).toContain("is-oscillating")
  })

  // Matched case-insensitively on the status name alone: how the labels are worded and capitalised is a
  // copy decision, and a test that pinned the prose would fail on an edit that changed nothing.
  it("names the statuses on screen in the legend, worst last", () => {
    // Both walked cells graded, so the row under test is the scale rather than the ungraded catch-all.
    const node = build(statusLevel([[1, [["0,0", "oscillating"], ["1,0", "explored"]]]]))
    scrubTo(node, 1)
    const items = queryAll<HTMLElement>(node, ".maze-visit-legend .maze-legend-item")
      .map((item) => item.textContent ?? "")

    // The composed part, not the gloss. The name and the "cells with" stem are built at render, so a
    // broken composition shows up here as "undefined - cells with ..."; the gloss after it is prose and
    // pinning it made this test fail on an edit that changed nothing about the mechanism.
    expect(items.some((text) => /^Explored - cells with \S/.test(text))).toBe(true)
    expect(items.some((text) => /^explored/i.test(text))).toBe(true)
    expect(items.at(-1)).toMatch(/^oscillating/i)
    // The scale reads worst-last, so unvisited opens it.
    expect(items.at(0)).toMatch(/^unvisited/i)

    // The drift guard. The label is composed from the status, so it cannot disagree with the swatch -
    // and this is what holds that true if anyone ever writes the names out by hand again. Read from the
    // rendered swatch class rather than from a list here, so the assertion has an independent source.
    for (const item of queryAll<HTMLElement>(node, ".maze-visit-legend .maze-legend-item")) {
      const status = [...query(item, ".maze-legend-swatch").classList]
        .find((name) => name.startsWith("is-"))
        ?.slice(3)
      expect(status).toBeDefined()
      const capitalised = `${(status ?? "").charAt(0).toUpperCase()}${(status ?? "").slice(1)}`
      expect(item.textContent).toMatch(new RegExp(`^${capitalised} - cells with `))
    }
  })

  // A cell no reading covers gets its own row and its own mark, after the scale rather than inside it.
  // Which cells those are depends on where the scrubber is, so the row is named for the reason that
  // actually applies there - one label cannot be true at both ends.
  const ungradedRow = (node: ParentNode) =>
    queryAll<HTMLElement>(node, ".maze-visit-legend .maze-legend-item")
      .map((item) => item.textContent ?? "")
      .at(-1)

  it("names the closing turn's cells at the end of the round", () => {
    // Tapoo stops logging these tools once the round is decided, so nothing covers the last batch.
    const node = build(statusLevel([[1, [["0,0", "oscillating"]]]]))
    scrubTo(node, 3)

    expect(ungradedRow(node)).toMatch(/^Closing turn/)
    expect(queryAll(node, ".maze-overlay rect.maze-cell.is-ungraded").length).toBeGreaterThan(0)
  })

  // The start square is stood on before a move is made, so frame 0 must show it graded rather than
  // waiting. No payload grades it at turn 0 - Tapoo's window holds only that square, and a cell is
  // graded by a neighbour pointing back at it - so the first grade it ever receives is backfilled,
  // which is sound only because the square cannot be re-entered without moves that postdate it.
  it("grades the start square at frame 0, before any move", () => {
    const node = build(statusLevel([[1, [["0,0", "oscillating"]]]]))
    scrubTo(node, 0)

    expect(queryAll(node, ".maze-overlay rect.maze-cell.is-ungraded")).toHaveLength(0)
    expect(queryAll(node, ".maze-overlay rect.maze-cell.is-oscillating")).toHaveLength(1)
    expect(ungradedRow(node)).not.toMatch(/^Awaiting|^Closing/)
  })

  // Mid-round, a cell no payload has named yet is waiting on the next turn's reading - not on the
  // closing turn, which has not happened.
  it("says a reading is awaited before the round has ended", () => {
    const node = build(statusLevel([]))
    scrubTo(node, 1)

    expect(ungradedRow(node)).toMatch(/^Awaiting a reading/)
    expect(queryAll(node, ".maze-overlay rect.maze-cell.is-ungraded").length).toBeGreaterThan(0)
  })

  // The counts have to sum to the maze, or the key is describing something other than the grid beside
  // it. unvisited is the remainder: no cell in frame.visited can be unvisited.
  it("counts unvisited as the maze area less the cells walked", () => {
    const node = build(level())
    scrubTo(node, 2)

    const counts = new Map(
      queryAll<HTMLElement>(node, ".maze-visit-legend .maze-legend-item").map((item) => {
        const text = item.textContent ?? ""
        return [text.split(" ")[0]?.toLowerCase() ?? "", Number(text.split(" - ").at(-1))]
      }),
    )
    const walked = queryAll(node, ".maze-overlay rect.maze-cell").length

    // The fixture maze is 4x6.
    expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBe(24)
    expect(counts.get("unvisited")).toBe(24 - walked)
  })
})

// The lens is a viewBox crop of the same drawing: 2r+1 cells rendered into the box that held the whole
// grid, which is the whole of the magnification. Sized to historyWindowRadius, it is the window the
// agent actually had.
describe("the magnifier", () => {
  const radiusLevel = (historyWindowRadius: number | null) => ({...level(), historyWindowRadius})
  const button = (node: ParentNode) => query<HTMLButtonElement>(node, ".maze-magnify")
  const lensBox = (node: ParentNode) =>
    node.querySelector(".maze-lens-grid")?.getAttribute("viewBox") ?? null
  const hover = (node: ParentNode, cell: string) => {
    const hit = query(node, `.maze-hits rect[data-cell="${cell}"]`)
    hit.dispatchEvent(new window.Event("pointerover", {bubbles: true}))
  }

  it("shows nothing until the mode is turned on", () => {
    const node = build(radiusLevel(2))

    expect(query(node, ".maze-lens").classList.contains("is-open")).toBe(false)
    expect(button(node).getAttribute("aria-pressed")).toBe("false")
    expect(button(node).textContent).toBe("Magnify")
    expect(query(node, ".maze-figure").classList.contains("is-magnifying")).toBe(false)
  })

  // The label says what the button is doing, not only what it would do - the same fact aria-pressed
  // carries, for the readers who cannot hear it.
  it("says it is magnifying while the mode is on", () => {
    const node = build(radiusLevel(2))

    button(node).click()
    expect(button(node).textContent).toBe("Magnifying")

    button(node).click()
    expect(button(node).textContent).toBe("Magnify")
  })

  // Opening on the agent's cell means the mode shows something at once, and the useful thing: the
  // window the agent had on the scrubbed turn.
  it("opens on the agent's current cell", () => {
    const node = build(radiusLevel(2))
    scrubTo(node, 3)
    button(node).click()

    // The fixture ends on "2,1": a 5-cell window is (col-2)*32, (row-2)*32, 5*32 square.
    expect(lensBox(node)).toBe(`${(1 - 2) * 32} ${(2 - 2) * 32} ${5 * 32} ${5 * 32}`)
    expect(query(node, ".maze-figure").classList.contains("is-magnifying")).toBe(true)
  })

  it("follows the pointer to another cell", () => {
    const node = build(radiusLevel(2))
    button(node).click()
    hover(node, "1,3")

    expect(lensBox(node)).toBe(`${(3 - 2) * 32} ${(1 - 2) * 32} ${5 * 32} ${5 * 32}`)
    expect(query(node, ".maze-lens-note").textContent).toMatch(/^Visited cells the agent can see from row=1, col=3/)
  })

  // Touch has no hover, so a tap has to count as one.
  it("accepts a tap where there is no hover", () => {
    const node = build(radiusLevel(1))
    button(node).click()
    query(node, '.maze-hits rect[data-cell="2,2"]').dispatchEvent(
      new window.Event("click", {bubbles: true}),
    )

    expect(lensBox(node)).toBe(`${(2 - 1) * 32} ${(2 - 1) * 32} ${3 * 32} ${3 * 32}`)
  })

  // An agent in a corner genuinely has fewer cells in range. Sliding the crop back inside would centre
  // the lens on a cell it was not standing on.
  it("lets the window run off the grid at an edge rather than clamping it", () => {
    const node = build(radiusLevel(2))
    button(node).click()
    hover(node, "0,0")

    expect(lensBox(node)).toBe(`${-2 * 32} ${-2 * 32} ${5 * 32} ${5 * 32}`)
  })

  // The crop is a square and the window is a diamond: at radius 2, 25 cells crop and 13 are reachable,
  // so 12 are covered. Without this the lens would overstate how far the window reached.
  it("covers the corners the Manhattan radius does not reach", () => {
    const node = build(radiusLevel(2))
    button(node).click()
    hover(node, "2,2")

    const dimmed = queryAll<SVGRectElement>(node, ".maze-lens-out")
      .map((rect) => rect.getAttribute("data-cell"))
    expect(dimmed).toHaveLength(12)
    expect(dimmed).toContain("0,0")
    expect(dimmed).not.toContain("2,0")
  })

  // The magnification is ours to choose; the window is the log's to state. Without a recorded radius the
  // lens still magnifies but makes no claim about what the agent can see.
  it("magnifies without claiming the agent's window when no radius was recorded", () => {
    const node = build(radiusLevel(null))
    button(node).click()
    hover(node, "2,2")

    expect(lensBox(node)).not.toBeNull()
    expect(queryAll(node, ".maze-lens-out")).toHaveLength(0)
    // Matched on the claim, not on the words. The note here says the log "did not record how far the
    // history window reached" - a denial that contains the same phrase as the assertion, which is why
    // this checks for the positive form rather than for the substring.
    expect(query(node, ".maze-lens-note").textContent).toMatch(/did not record/)
    expect(query(node, ".maze-lens-note").textContent).not.toMatch(/^Visited cells the agent can see/)
  })

  // The lens draws the decoded structure, including walls on ground the agent never entered. Without
  // this qualifier a reader would take those corridors for something the model had in front of it, so it
  // is stated in both branches: it is a fact about the tool, not about whether a radius was recorded.
  it("denies the agent the unvisited structure it draws", () => {
    for (const radius of [2, null]) {
      const node = build(radiusLevel(radius))
      button(node).click()
      hover(node, "2,2")

      expect(query(node, ".maze-lens-caveat").textContent).toMatch(/never exposed/)
    }
  })

  // The one that fails if the lens is built in showLevel rather than paint().
  it("redraws as the scrubber moves, without leaving its cell", () => {
    const node = build(radiusLevel(2))
    button(node).click()
    hover(node, "1,0")

    scrubTo(node, 1)
    const early = query(node, ".maze-lens-grid").innerHTML
    scrubTo(node, 3)
    const late = query(node, ".maze-lens-grid").innerHTML

    expect(early).not.toBe(late)
    expect(lensBox(node)).toBe(`${(0 - 2) * 32} ${(1 - 2) * 32} ${5 * 32} ${5 * 32}`)
  })

  it("hides the lens and the cursor again when the mode is turned off", () => {
    const node = build(radiusLevel(2))
    button(node).click()
    button(node).click()

    expect(query(node, ".maze-lens").classList.contains("is-open")).toBe(false)
    expect(query(node, ".maze-figure").classList.contains("is-magnifying")).toBe(false)
    expect(button(node).getAttribute("aria-pressed")).toBe("false")
  })
})

describe("the decay legend", () => {
  const legend = (node: ParentNode) =>
    queryAll<HTMLElement>(node, ".maze-decay-legend .maze-legend-item").map((item) => item.textContent ?? "")

  const charged = (...values: Array<number | null>) => {
    const base = level()
    return {...base, turns: base.turns.map((turn, index) => ({...turn, decayCharged: values[index] ?? null}))}
  }

  it("names each charge and counts it, so a two-pixel bar means something", () => {
    expect(legend(build(charged(1, 2, 3)))).toEqual([
      "base charge - 1",
      "invalid move - 1",
      "output format violation - 1",
    ])
  })

  it("counts every turn that paid each charge", () => {
    expect(legend(build(charged(1, 1, 2)))).toEqual(["base charge - 2", "invalid move - 1"])
  })

  // The key describes the strip above it, and that strip fades everything ahead of the thumb - so the
  // counts have to move with it. The round's own totals live in the level summary's Turns row, which is
  // where a reader goes for the figure that does not move.
  //
  // The suite reads the default position, which is the end of the round, so every other assertion here
  // would pass whether this followed the scrubber or not.
  it("counts only the turns played so far", () => {
    const node = build(charged(1, 1, 2))

    scrubTo(node, 1)
    expect(legend(node)).toEqual(["base charge - 1"])

    scrubTo(node, 2)
    expect(legend(node)).toEqual(["base charge - 2"])

    scrubTo(node, 3)
    expect(legend(node)).toEqual(["base charge - 2", "invalid move - 1"])
  })

  it("names nothing at the start position, where no turn has been charged", () => {
    const node = build(charged(1, 1, 2))
    scrubTo(node, 0)

    expect(legend(node)).toEqual([])
  })

  it("lists only the charges this round actually incurred", () => {
    // A legend naming a penalty that never happened describes the rules rather than the run, and the
    // run is what the reader is looking at.
    expect(legend(build(charged(1, 1, 1)))).toEqual(["base charge - 3"])
  })

  it("keeps the swatch colours in step with the bars", () => {
    const swatches = queryAll<HTMLElement>(build(charged(1, 2, 3)), ".maze-decay-legend .maze-legend-swatch")
      .map((swatch) => [...swatch.classList].find((name) => name.startsWith("is-decay-")))

    expect(swatches).toEqual(["is-decay-1", "is-decay-2", "is-decay-3"])
  })

  it("says nothing when the round reports no charge at all", () => {
    expect(query(build(level()), ".maze-decay-legend").hidden).toBe(true)
  })

  // The Turns row and the legend are two renderings of decayTally. This is the assertion that keeps
  // them one partition: if either drifts, a reader adding the bottom bars up stops landing on the row.
  it("shows the same partition in the Turns row, in the strip's own colours", () => {
    const node = build(charged(1, 1, 2))
    const cell = query(node, ".maze-turns-cell")

    expect(query(cell, ".maze-turns-total").textContent).toBe("3")
    expect(queryAll<HTMLElement>(cell, ".maze-turns-part").map((part) => [
      [...part.classList].find((name) => name.startsWith("is-decay-")),
      query(part, ".maze-turns-count").textContent,
      part.title,
    ])).toEqual([
      ["is-decay-1", "2", "base charge"],
      ["is-decay-2", "1", "invalid move"],
    ])
  })

  // Colour is what ties the row to the strip, and colour is exactly what a screen reader cannot relay.
  it("names each count in words for a reader who sees no colour", () => {
    expect(query(build(charged(1, 1, 2)), ".maze-turns-cell").textContent)
      .toBe("32 base charge1 invalid move")
  })

  it("keeps unreported turns visible rather than folding them into a charge", () => {
    const parts = queryAll<HTMLElement>(build(charged(1, 2, null)), ".maze-turns-part")
    expect(parts.map((part) => part.title)).toEqual([
      "base charge", "invalid move", "decay not reported",
    ])
  })

  // A lone part is the total restated; "3 (3)" would read as a breakdown that lost two thirds of itself.
  it("leaves the count undivided when every turn paid the same charge", () => {
    expect(queryAll(build(charged(1, 1, 1)), ".maze-turns-part")).toHaveLength(0)
    expect(query(build(charged(1, 1, 1)), ".maze-turns-total").textContent).toBe("3")
  })

  // A round that decoded no maze draws no legend: the charges belong to a grid that is not on screen.
  it("draws no decay legend for a round whose maze is invalid", () => {
    const node = build(level({game: 3, encodedMaze: null}))

    expect(legend(node)).toEqual([])
    expect(query(node, ".maze-decay-legend").hidden).toBe(true)
  })
})
