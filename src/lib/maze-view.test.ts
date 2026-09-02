/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest"

import {createMazeReplay} from "./maze-view"
import type {EncodedMaze, Level} from "./types"
import {at, query, queryAll, reportWith} from "./test-support";

const REAL_MAZE = {
  index_chars: ["|", "---", "-", "   ", " ", "\n"],
  structure_checksum: "0x74af82cb14470b9d",
  structure:
    "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
  dimensions: { numCols: 6, numRows: 4, area: 24 },
}

type LevelOverrides = {encodedMaze?: EncodedMaze | null; game?: number; lvl?: number}

const level = ({encodedMaze = REAL_MAZE, game = 2, lvl = 1}: LevelOverrides = {}): Level => ({
  key: `${game}/${lvl}`,
  game,
  level: lvl,
  encodedMaze,
  startCell: "0,0",
  startPosition: null,
  historyWindowRadius: null,
  // A resolved cell key: buildLevels reads the logged shape - which may be {row, col} or
  // [row, col] - through the contract, so a level model never carries the raw form.
  destinationCell: "0,5",
  endCell: "2,1",
  observedExits: new Map(),
  positions: [],
  turns: [
    { turn: 0, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null, decayCharged: null },
    { turn: 1, playerName: "Katara", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null, decayCharged: null },
    {
      turn: 2,
      playerName: "Katara",
      before: "2,0",
      moves: ["MoveRight", "MoveUp"],
      applied: 1,
      cells: ["2,0", "2,1"],
      rejectedMove: "MoveUp", decayCharged: null,
    },
  ],
  outcome: { outcome: "won", traversalSpeed: "1.0000", playerUniqueCellsVisited: 17, decayUnitsCharged: 17 },
})

// The view shapes its own data now, so a test hands it the same report the page does.
const build = (levels: Level[]) => createMazeReplay(reportWith(...levels))

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
    const node = build([level()])

    expect(node.querySelector("svg.maze-grid")).not.toBeNull()
    expect(node.querySelector(".maze-overlay")).not.toBeNull()
    // 24 cells with walls on every closed edge, so a real grid always has lines.
    expect(node.querySelectorAll("svg line").length).toBeGreaterThan(20)
  })

  it("opens at the end of the round", () => {
    const node = build([level()])

    expect(range(node).value).toBe("3")
    expect(query(node, ".maze-readout").textContent).toBe("3 / 3")
  })

  it("repaints when the scrubber moves", () => {
    const node = build([level()])

    scrubTo(node, 0)
    expect(caption(node)).toMatch(/Start position/)
    expect(query(node, ".maze-readout").textContent).toBe("0 / 3")
    // No agent has acted yet, so no position marker is drawn.
    expect(overlayCircles(node)).toHaveLength(0)

    scrubTo(node, 1)
    // Short now: the bars carry the shape of the round, and a single-agent round does not repeat
    // the agent's name on every frame.
    expect(caption(node)).toBe("Turn 0 \u00b7 1 of 1 applied")
    expect(overlayCircles(node)).toHaveLength(1)
  })

  // The refusal is named in the caption and shown on the bars, and no longer drawn on the grid: a bar
  // whose green share falls short of its height is a turn that asked for more than it got, and that
  // reads across the whole run rather than only on the turn you have scrubbed to.
  it("names the refused move on the turn that produced it, without marking the grid", () => {
    const node = build([level()])

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
    const node = build([level({ encodedMaze: { ...REAL_MAZE, structure: `${REAL_MAZE.structure}0` } })])

    expect(node.querySelector("svg.maze-grid")).toBeNull()
    expect(query(node, ".notice-error").textContent).toMatch(/checksum/)
    expect(query(node, ".maze-scrubber").hidden).toBe(true)
  })

  it("offers a selector only when the log holds more than one round", () => {
    expect(build([level()]).querySelector(".maze-level-select")).toBeNull()

    const many = build([level({ game: 1 }), level({ game: 2 })])
    const select = query<HTMLSelectElement>(many, ".maze-level-select")
    expect(select).not.toBeNull()
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Level 1 (game 1)",
      "Level 1 (game 2)",
    ])
  })

  it("redraws the grid when another round is selected", () => {
    const node = build([level({ game: 1 }), level({ game: 2, encodedMaze: null })])
    const select = query<HTMLSelectElement>(node, ".maze-level-select")

    expect(node.querySelector("svg.maze-grid")).not.toBeNull()

    select.value = "1"
    select.dispatchEvent(new window.Event("change", { bubbles: true }))

    expect(node.querySelector("svg.maze-grid")).toBeNull()
    expect(query(node, ".notice-error").textContent).toMatch(/carries no encoded maze/)
  })

  it("renders nothing for a report with no rounds", () => {
    expect(build([]).querySelector("svg")).toBeNull()
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
    const drawn = markers(build([level()]))

    expect(drawn).toHaveLength(2)
    for (const marker of drawn) {
      expect(marker.width).toBeGreaterThan(0)
      expect(marker.height).toBeGreaterThan(0)
    }
  })

  it("tells them apart by size, not only by colour", () => {
    // Rose against muted is the one pairing a red-green colour deficiency cannot separate, and the two
    // marks mean opposite things on the same grid.
    const [first, second] = markers(build([level()]))

    expect(first?.width).not.toBe(second?.width)
  })

  it("paints the landmarks above the trail, not under it", () => {
    // SVG has no z-index - paint order is document order. The start cell is in frame.visited from
    // frame 0 by construction and the visited tint is a full-cell opaque rect, so markers drawn before
    // the overlay were buried at every frame while looking perfectly correct in the DOM.
    const svg = query(build([level()]), "svg.maze-grid")
    const children = [...svg.children]
    const overlay = children.findIndex((child) => child.classList.contains("maze-overlay"))
    const firstMarker = children.findIndex((child) => child.tagName === "rect")

    expect(overlay).toBeGreaterThanOrEqual(0)
    expect(firstMarker).toBeGreaterThan(overlay)
  })

  it("keeps the start marker visible on the frame that covers its cell", () => {
    // Frame 0 already tints the start cell. This is the case that was broken.
    const node = build([level()])
    scrubTo(node, 0)
    const svg = query(node, "svg.maze-grid")
    const children = [...svg.children]
    const overlay = children.findIndex((child) => child.classList.contains("maze-overlay"))

    expect(queryAll<SVGRectElement>(svg, ":scope > rect")).toHaveLength(2)
    expect(children.findIndex((child) => child.tagName === "rect")).toBeGreaterThan(overlay)
  })

  it("draws neither when the round records no start or destination", () => {
    const bare = {...level(), startCell: null, destinationCell: null}

    expect(markers(build([bare]))).toHaveLength(0)
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
    const node = build([charged(1, 2, 1)])

    expect(bars(node, "moves")).toHaveLength(3)
    expect(bars(node, "decay")).toHaveLength(3)
  })

  it("sizes a moves bar by what was submitted, against the round's own maximum", () => {
    // Turn 2 submits two moves and the others one, so it is the tallest and sets the scale.
    //
    // Square root, not linear: these distributions are long-tailed, and in a real round one turn
    // submitting twelve moves squashed the 261 turns that submitted one down to 2px of a 24px strip.
    const heights = bars(build([level()]), "moves").map((bar) => Math.round(parseFloat(bar.style.height)))

    expect(heights).toEqual([71, 71, 100])
  })

  it("fills the applied share and leaves the rest", () => {
    // Turn 2 submitted two and landed one, which is the whole point of the green: the ungreened part
    // is exactly what the agent asked for and did not get.
    const shares = bars(build([level()]), "moves").map((bar) => bar.style.getPropertyValue("--applied"))

    expect(shares).toEqual(["100%", "100%", "50%"])
  })

  it("names each turn on the bar, so a sliver is still readable", () => {
    // At 464 turns a bar is under two pixels wide; the title is the only way to read one.
    expect(at(bars(build([level()]), "moves"), 2).title).toBe("Turn 2: 1 of 2 applied")
  })

  it("separates the bars where there is room, and closes the gap where there is not", () => {
    // At 464 turns a 2px gap would take 463px of an 830px strip and leave each bar under a pixel - a
    // separation that erases what it is meant to separate.
    const many = (count: number) => {
      const base = level()
      const turn = at(base.turns, 0)
      return {...base, turns: Array.from({length: count}, (_, index) => ({...turn, turn: index}))}
    }

    expect(query(build([many(16)]), ".maze-bars-moves").style.gap).toBe("2px")
    expect(query(build([many(150)]), ".maze-bars-moves").style.gap).toBe("1px")
    expect(query(build([many(464)]), ".maze-bars-moves").style.gap).toBe("0px")
  })

  it("marks the scrubbed turn in both strips", () => {
    const node = build([charged(1, 2, 1)])
    scrubTo(node, 2)

    expect(bars(node, "moves").map((bar) => bar.classList.contains("is-current")))
      .toEqual([false, true, false])
    expect(bars(node, "decay").map((bar) => bar.classList.contains("is-current")))
      .toEqual([false, true, false])
  })

  it("fades the turns the scrubber has not reached, the way the slider fades its track", () => {
    // All three layers then read as one control: left of the thumb has happened, right of it has not.
    const node = build([charged(1, 2, 1)])
    scrubTo(node, 1)

    expect(bars(node, "moves").map((bar) => bar.classList.contains("is-future")))
      .toEqual([false, true, true])
    expect(bars(node, "decay").map((bar) => bar.classList.contains("is-future")))
      .toEqual([false, true, true])
  })

  it("fades nothing once the scrubber is at the end", () => {
    const node = build([charged(1, 2, 1)])
    scrubTo(node, 3)

    expect(bars(node, "moves").some((bar) => bar.classList.contains("is-future"))).toBe(false)
  })

  it("tracks how far along the slider is, so its own fill matches the strips", () => {
    const node = build([charged(1, 2, 1)])
    scrubTo(node, 1)

    expect(query<HTMLInputElement>(node, "input[type=range]").style.getPropertyValue("--progress"))
      .toBe(`${(1 / 3) * 100}%`)
  })

  it("marks nothing at the start position, which is no turn at all", () => {
    const node = build([level()])
    scrubTo(node, 0)

    expect(bars(node, "moves").some((bar) => bar.classList.contains("is-current"))).toBe(false)
  })

  it("draws an unreported charge as unknown, not as zero", () => {
    // A cost nothing recorded is not a cost of nothing, and a flat bar would claim the turn was free.
    const node = build([charged(1, 2, null)])
    const unknown = bars(node, "decay").filter((bar) => bar.classList.contains("is-unknown"))

    expect(unknown).toHaveLength(1)
    expect(at(unknown, 0).style.height).toBe("100%")
    expect(at(bars(node, "decay"), 2).title).toBe("Turn 2: decay not reported")
  })

  it("hides the decay strip when the round reports no charge at all", () => {
    // An agent that never called get_last_prediction_outcome - the case C3.Q3 exists to detect - gets
    // no strip rather than a band of unknowns.
    const node = build([level()])

    expect(query(node, ".maze-bars-decay").hidden).toBe(true)
  })

  it("shows the decay strip and scales it once charges are reported", () => {
    const node = build([charged(1, 1, 4)])

    expect(query(node, ".maze-bars-decay").hidden).toBe(false)
  })

  it("draws the three charges at different heights, and colours what each one means", () => {
    // Height is how much it cost, colour is what it was for. Both, because a height alone cannot say
    // whether two units were a wall or a broken response.
    const decay = bars(build([charged(1, 2, 3)]), "decay")

    expect(decay.map((bar) => Math.round(parseFloat(bar.style.height)))).toEqual([33, 67, 100])
    expect(decay.map((bar) => [...bar.classList].find((name) => name.startsWith("is-decay-"))))
      .toEqual(["is-decay-1", "is-decay-2", "is-decay-3"])
  })

  it("reads decay on an absolute scale, so a cheap round looks cheap", () => {
    // Scaled to the round, a run that only ever paid the base rate drew every bar full height - the
    // cheapest possible round rendered as the most expensive one.
    const allBase = bars(build([charged(1, 1, 1)]), "decay")

    expect(allBase.map((bar) => Math.round(parseFloat(bar.style.height)))).toEqual([33, 33, 33])
  })

  it("tells the three charging states apart by colour", () => {
    const classes = bars(build([charged(1, 2, 3)]), "decay")
      .map((bar) => [...bar.classList].find((name) => name.startsWith("is-decay-")))

    expect(classes).toEqual(["is-decay-1", "is-decay-2", "is-decay-3"])
  })

  it("names why each turn was charged, and marks the severity", () => {
    // Every turn pays a base unit; an invalid move costs two; a broken response format costs three.
    const node = build([charged(1, 2, 3)])
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

describe("the decay legend", () => {
  const legend = (node: ParentNode) =>
    queryAll<HTMLElement>(node, ".maze-legend-item").map((item) => item.textContent ?? "")

  const charged = (...values: Array<number | null>) => {
    const base = level()
    return {...base, turns: base.turns.map((turn, index) => ({...turn, decayCharged: values[index] ?? null}))}
  }

  it("names each charge and counts it, so a two-pixel bar means something", () => {
    expect(legend(build([charged(1, 2, 3)]))).toEqual([
      "base charge - 1",
      "invalid move - 1",
      "output format violation - 1",
    ])
  })

  it("counts every turn that paid each charge", () => {
    expect(legend(build([charged(1, 1, 2)]))).toEqual(["base charge - 2", "invalid move - 1"])
  })

  it("lists only the charges this round actually incurred", () => {
    // A legend naming a penalty that never happened describes the rules rather than the run, and the
    // run is what the reader is looking at.
    expect(legend(build([charged(1, 1, 1)]))).toEqual(["base charge - 3"])
  })

  it("keeps the swatch colours in step with the bars", () => {
    const swatches = queryAll<HTMLElement>(build([charged(1, 2, 3)]), ".maze-legend-swatch")
      .map((swatch) => [...swatch.classList].find((name) => name.startsWith("is-decay-")))

    expect(swatches).toEqual(["is-decay-1", "is-decay-2", "is-decay-3"])
  })

  it("says nothing when the round reports no charge at all", () => {
    expect(query(build([level()]), ".maze-legend").hidden).toBe(true)
  })
})
