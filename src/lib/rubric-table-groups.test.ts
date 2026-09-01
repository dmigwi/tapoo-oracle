/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest"
import * as Inputs from "@observablehq/inputs"

import {enableRowSelection, prepareRubricTable} from "./rubric-table"
import {at, query, queryAll} from "./test-support";

// Built the way index.md builds it, against the real Inputs.table: the merge reads the header row to
// find its columns and edits the body Inputs.table produced, so a stub table would be testing the
// stub's shape rather than the one that ships.
function rubricTable(rows: RubricRow[]) {
  return prepareRubricTable(Inputs.table(rows, {
    columns: ["id", "group", "question", "groupResult"],
    header: {id: "ID", group: "Group", question: "Fact question", groupResult: "Group result"},
    sort: false,
    rows: rows.length,
  }))
}

// Two groups: one answered by three questions, one by a single question.
type RubricRow = {id: string; group: string; question: string; groupResult: string}

const rubricRows: RubricRow[] = [
  {id: "C1.Q1", group: "INSTRUCTION ADHERENCE", question: "bare JSON?", groupResult: "YES (3/3)"},
  {id: "C1.Q2", group: "INSTRUCTION ADHERENCE", question: "one moves key?", groupResult: "YES (3/3)"},
  {id: "C1.Q3", group: "INSTRUCTION ADHERENCE", question: "known commands?", groupResult: "YES (3/3)"},
  {id: "C2.Q1", group: "VALID ACTION DELIVERY", question: "a move applied?", groupResult: "YES (1/1)"},
]

// prepareRubricTable returns the table carrying its selected rows on `value`, the viewof protocol.
const selectionOf = (node: HTMLElement) => (node as HTMLElement & {value: RubricRow[]}).value

const bodyRows = (node: ParentNode) => queryAll<HTMLTableRowElement>(node, "tbody tr")
const textOf = (row: HTMLTableRowElement) => [...row.cells].map((cell) => cell.textContent.trim())

describe("prepareRubricTable", () => {
  it("states a group's verdict once, spanning its questions", () => {
    const node = rubricTable(rubricRows)
    const first = at(bodyRows(node), 0)
    const spanned = [...first.cells].filter((cell) => cell.rowSpan > 1)

    expect(spanned.map((cell) => cell.textContent.trim())).toEqual([
      "INSTRUCTION ADHERENCE",
      "YES (3/3)",
    ])
    expect(spanned.every((cell) => cell.rowSpan === 3)).toBe(true)
  })

  it("removes the repeated cells from the rest of the group", () => {
    const node = rubricTable(rubricRows)
    const items = bodyRows(node)
    const second = at(items, 1)
    const third = at(items, 2)

    // Repeating the verdict on every row reads as several verdicts that happen to agree. The rubric
    // has one verdict per group, and the questions are its evidence.
    expect(textOf(second)).toEqual(["", "C1.Q2", "one moves key?"])
    expect(textOf(third)).toEqual(["", "C1.Q3", "known commands?"])
  })

  it("leaves a single-question group with its own cells intact", () => {
    const node = rubricTable(rubricRows)
    const items = bodyRows(node)
    const fourth = at(items, 3)

    // Nothing to span across, so nothing is spanned - and the cells must not be stripped from a row
    // that is its own group.
    expect(textOf(fourth)).toEqual(["", "C2.Q1", "VALID ACTION DELIVERY", "a move applied?", "YES (1/1)"])
    expect([...fourth.cells].every((cell) => cell.rowSpan === 1)).toBe(true)
  })

  it("keeps every question row, merging only the repeated columns", () => {
    const node = rubricTable(rubricRows)

    expect(bodyRows(node)).toHaveLength(rubricRows.length)
  })

  it("starts a new run when the group changes back to one seen earlier", () => {
    // Groups are contiguous in a real report, but merging by identity rather than by adjacency would
    // silently span across an unrelated group sitting between two runs of the same label.
    const node = rubricTable([
      {id: "C1.Q1", group: "A", question: "first", groupResult: "YES (1/1)"},
      {id: "C2.Q1", group: "B", question: "second", groupResult: "NO (0/1)"},
      {id: "C3.Q1", group: "A", question: "third", groupResult: "YES (1/1)"},
    ])

    expect(bodyRows(node).every((row) => row.cells.length === 5)).toBe(true)
    expect(bodyRows(node).every((row) => [...row.cells].every((cell) => cell.rowSpan === 1))).toBe(true)
  })

  it("still selects the whole row after the merge", () => {
    const node = prepareRubricTable(enableRowSelection(Inputs.table(rubricRows, {
      columns: ["id", "group", "question", "groupResult"],
      header: {id: "ID", group: "Group", question: "Fact question", groupResult: "Group result"},
      sort: false,
      rows: rubricRows.length,
    })))
    const items = bodyRows(node)
    const second = at(items, 1)

    // The merge removes cells from rows, and the row click finds its checkbox through the row - so
    // the two passes have to survive each other.
    at([...second.cells], second.cells.length - 1)
      .dispatchEvent(new window.MouseEvent("click", {bubbles: true, detail: 1}))

    expect(query<HTMLInputElement>(second, "input[type=checkbox]").checked).toBe(true)
    expect(selectionOf(node).map((row) => row.id)).toEqual(["C1.Q2"])
  })

  it("returns the node untouched when it holds no table", () => {
    const node = window.document.createElement("form")

    expect(prepareRubricTable(node)).toBe(node)
  })
})
