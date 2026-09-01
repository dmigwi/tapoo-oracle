/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest"

import {createMazeReplay} from "./maze-view"
import type {EncodedMaze, Level} from "./types"
import {query, queryAll, reportWith} from "./test-support";

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
    { turn: 0, playerName: "Katara", before: "0,0", moves: ["MoveDown"], applied: 1, cells: ["0,0", "1,0"], rejectedMove: null },
    { turn: 1, playerName: "Katara", before: "1,0", moves: ["MoveDown"], applied: 1, cells: ["1,0", "2,0"], rejectedMove: null },
    {
      turn: 2,
      playerName: "Katara",
      before: "2,0",
      moves: ["MoveRight", "MoveUp"],
      applied: 1,
      cells: ["2,0", "2,1"],
      rejectedMove: "MoveUp",
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
    expect(caption(node)).toMatch(/Turn 0: Katara submitted MoveDown - 1 of 1 applied/)
    expect(overlayCircles(node)).toHaveLength(1)
  })

  it("names the refused move on the turn that produced it", () => {
    const node = build([level()])

    scrubTo(node, 3)
    expect(caption(node)).toMatch(/MoveRight, MoveUp - 1 of 2 applied, MoveUp refused/)
    expect(range(node).getAttribute("aria-valuetext")).toMatch(/MoveUp refused/)

    // Marked by shape, not hue: two crossed strokes plus their halo, drawn on the wall it hit.
    const crossStrokes = queryAll(node, ".maze-overlay line")
    expect(crossStrokes).toHaveLength(4)
    expect(crossStrokes.some((line) => line.getAttribute("stroke") === "var(--oracle-rose)")).toBe(true)

    scrubTo(node, 2)
    expect(node.querySelectorAll(".maze-overlay line")).toHaveLength(0)
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

