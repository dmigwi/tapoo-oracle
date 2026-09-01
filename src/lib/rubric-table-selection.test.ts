/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest"
import * as Inputs from "@observablehq/inputs"

import {enableRowSelection} from "./rubric-table"
import {at, query, queryAll} from "./test-support";

// Driven against the real Inputs.table, not a hand-rolled table of checkboxes, and that is the whole
// point of this file. A plain checkbox toggles on click whatever the handler does, so a stub would
// have passed while the shipped behavior was broken: Inputs.table wires each row checkbox with
// `input.onclick = reselect`, and that handler - not the checkbox - owns the selection set, the
// header checkbox, and the table's value. Setting .checked directly moved the tick and nothing else.
function rubricTable(rowCount = 3) {
  const rows = Array.from({length: rowCount}, (unused, index) => ({
    id: `C${index + 1}.Q1`,
    question: `question ${index + 1}`,
  }))

  return enableRowSelection(Inputs.table(rows, {sort: false, rows: rows.length}))
}

// enableRowSelection returns the table carrying its selected rows on `value`, the viewof protocol.
const selectionOf = (node: HTMLElement) => (node as HTMLElement & {value: {id: string}[]}).value

const bodyRows = (node: ParentNode) => queryAll<HTMLTableRowElement>(node, "tbody tr")
const headerCheckbox = (node: ParentNode) =>
  query<HTMLInputElement>(node, "thead input[type=checkbox]")
const rowCheckbox = (row: ParentNode) => query<HTMLInputElement>(row, "input[type=checkbox]")

// A cell that is not the checkbox cell, which is what "clicking the row" means.
function clickCell(row: HTMLTableRowElement, {shiftKey = false} = {}) {
  at([...row.cells], row.cells.length - 1)
    .dispatchEvent(new window.MouseEvent("click", {bubbles: true, detail: 1, shiftKey}))
}

describe("enableRowSelection", () => {
  it("checks the row's own checkbox when a cell in that row is clicked", () => {
    const node = rubricTable()
    const first = at(bodyRows(node), 0)

    clickCell(first)

    expect(rowCheckbox(first).checked).toBe(true)
  })

  it("adds the row to the table's value, not just its tick", () => {
    const node = rubricTable()
    const items = bodyRows(node)
    const second = at(items, 1)

    clickCell(second)

    // The regression this file exists for. The tick and the CSS :checked tint both moved while the
    // table's value never gained the row, so the row looked selected and the table disagreed.
    expect(selectionOf(node).map((row) => row.id)).toEqual(["C2.Q1"])
  })

  it("updates the header checkbox when every row has been clicked", () => {
    const node = rubricTable()

    bodyRows(node).forEach((row) => clickCell(row))

    expect(headerCheckbox(node).checked).toBe(true)
    expect(headerCheckbox(node).indeterminate).toBe(false)
  })

  it("leaves the header checkbox indeterminate while only some rows are selected", () => {
    const node = rubricTable()
    const first = at(bodyRows(node), 0)

    clickCell(first)

    expect(headerCheckbox(node).indeterminate).toBe(true)
  })

  it("deselects a selected row when its cell is clicked again", () => {
    const node = rubricTable()
    const first = at(bodyRows(node), 0)

    clickCell(first)
    clickCell(first)

    expect(rowCheckbox(first).checked).toBe(false)
    // Asserted through the header rather than through node.value: Inputs.table defaults to
    // required, so an empty selection reports every row as the value rather than none. An empty
    // array here would never be reached, and expecting one would fail against correct behavior.
    expect(headerCheckbox(node).checked).toBe(false)
    expect(headerCheckbox(node).indeterminate).toBe(false)
  })

  it("extends the selection when a row is shift-clicked", () => {
    const node = rubricTable()
    const items = bodyRows(node)
    const first = at(items, 0)
    const third = at(items, 2)

    clickCell(first)
    clickCell(third, {shiftKey: true})

    // Carried through from the original event. Without it a row click could only ever select one row
    // at a time, while a click on the checkbox two pixels away could select a range.
    expect(selectionOf(node).map((row) => row.id)).toEqual(["C1.Q1", "C2.Q1", "C3.Q1"])
    expect(headerCheckbox(node).checked).toBe(true)
  })

  it("does not toggle twice when the checkbox itself is clicked", () => {
    const node = rubricTable()
    const first = at(bodyRows(node), 0)

    rowCheckbox(first).dispatchEvent(new window.MouseEvent("click", {bubbles: true, detail: 1}))

    // Handling the control's own click as well would toggle it back, so a direct click on the
    // checkbox would appear to do nothing at all.
    expect(rowCheckbox(first).checked).toBe(true)
    expect(selectionOf(node).map((row) => row.id)).toEqual(["C1.Q1"])
  })

  it("leaves a link inside a cell doing what a link does", () => {
    const node = rubricTable()
    const first = at(bodyRows(node), 0)
    const link = window.document.createElement("a")
    link.href = "#somewhere"
    at([...first.cells], first.cells.length - 1).append(link)

    link.dispatchEvent(new window.MouseEvent("click", {bubbles: true, detail: 1}))

    expect(rowCheckbox(first).checked).toBe(false)
  })

  it("ignores a click that ends a text selection", () => {
    const node = rubricTable()
    const first = at(bodyRows(node), 0)
    // Stubbed rather than made with a real Range: jsdom implements Selection far enough to hold a
    // range but reports toString() as empty, so a real drag would not reach the branch under test.
    const realGetSelection = window.getSelection
    window.getSelection = () => ({toString: () => "question 1"}) as unknown as Selection

    try {
      clickCell(first)
    } finally {
      window.getSelection = realGetSelection
    }

    // Someone dragging across a fact question to copy it is reading, not choosing a row.
    expect(rowCheckbox(first).checked).toBe(false)
  })

  it("returns the node untouched when it holds no table", () => {
    const node = window.document.createElement("form")

    expect(enableRowSelection(node)).toBe(node)
  })
})
