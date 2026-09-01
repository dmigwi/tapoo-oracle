/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest"

import { levelSummaryRows, mazeReplayModel } from "./oracle.js"
import { createMazeReplay } from "./maze-view.js"

const REAL_MAZE = {
  index_chars: ["|", "---", "-", "   ", " ", "\n"],
  structure_checksum: "0x74af82cb14470b9d",
  structure:
    "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
  dimensions: { numCols: 6, numRows: 4, area: 24 },
}

const level = ({ encodedMaze = REAL_MAZE, game = 2, lvl = 1 } = {}) => ({
  key: `${game}/${lvl}`,
  game,
  level: lvl,
  encodedMaze,
  startCell: "0,0",
  destinationCell: { row: 0, col: 5 },
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

const build = (levels) => {
  const report = { levels }
  return createMazeReplay(mazeReplayModel(report), { levelSummary: levelSummaryRows(report) })
}

const range = (node) => node.querySelector("input[type=range]")
const caption = (node) => node.querySelector(".maze-caption").textContent
const overlayCircles = (node) => node.querySelectorAll(".maze-overlay circle")

// Driven through the real input element and a real input event, not by calling the paint function:
// a scrubber that never repaints on input would pass every assertion made against the function alone.
const scrubTo = (node, value) => {
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
    expect(node.querySelector(".maze-readout").textContent).toBe("3 / 3")
  })

  it("repaints when the scrubber moves", () => {
    const node = build([level()])

    scrubTo(node, 0)
    expect(caption(node)).toMatch(/Start position/)
    expect(node.querySelector(".maze-readout").textContent).toBe("0 / 3")
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
    const crossStrokes = [...node.querySelectorAll(".maze-overlay line")]
    expect(crossStrokes).toHaveLength(4)
    expect(crossStrokes.some((line) => line.getAttribute("stroke") === "var(--oracle-rose)")).toBe(true)

    scrubTo(node, 2)
    expect(node.querySelectorAll(".maze-overlay line")).toHaveLength(0)
  })

  it("reports a maze it cannot trust instead of drawing one", () => {
    const node = build([level({ encodedMaze: { ...REAL_MAZE, structure: `${REAL_MAZE.structure}0` } })])

    expect(node.querySelector("svg.maze-grid")).toBeNull()
    expect(node.querySelector(".notice-error").textContent).toMatch(/checksum/)
    expect(node.querySelector(".maze-scrubber").hidden).toBe(true)
  })

  it("offers a selector only when the log holds more than one round", () => {
    expect(build([level()]).querySelector(".maze-level-select")).toBeNull()

    const many = build([level({ game: 1 }), level({ game: 2 })])
    const select = many.querySelector(".maze-level-select")
    expect(select).not.toBeNull()
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Level 1 (game 1)",
      "Level 1 (game 2)",
    ])
  })

  it("redraws the grid when another round is selected", () => {
    const node = build([level({ game: 1 }), level({ game: 2, encodedMaze: null })])
    const select = node.querySelector(".maze-level-select")

    expect(node.querySelector("svg.maze-grid")).not.toBeNull()

    select.value = "1"
    select.dispatchEvent(new window.Event("change", { bubbles: true }))

    expect(node.querySelector("svg.maze-grid")).toBeNull()
    expect(node.querySelector(".notice-error").textContent).toMatch(/carries no encoded maze/)
  })

  it("renders nothing for a report with no rounds", () => {
    expect(build([]).querySelector("svg")).toBeNull()
  })
})
