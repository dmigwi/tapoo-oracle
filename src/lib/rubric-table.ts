// Post-processing for the rubric tables Inputs.table builds.
//
// These mutate a table node the caller already has, rather than building one: Inputs.table owns the
// markup, and re-implementing it here to add two behaviours would mean maintaining a copy of it.


// profileCards summarizes a report as headline counts.
//
// Capabilities and violations are reported as separate fractions and never combined. The rubric is
// explicit that they must not collapse into one score interval: a model with six capabilities and
// two violations is not "four", and any arithmetic that produces a single number here would be
// inventing a scale the contract deliberately refuses to define.
// Column classes, keyed by header text. Positional selectors cannot address these columns: rows
// after a group's first lose two cells to the merge below, so nth-last-child(4) is the group name on
// one row and the leading spacer on the next. A class travels with the cell.
const RUBRIC_COLUMN_CLASSES: Record<string, string> = {
  "ID": "rubric-id",
  "Group": "rubric-group",
  "Fact question": "rubric-question",
  "Answer": "rubric-answer",
  "Group result": "rubric-result",
}

// prepareRubricTable labels each column and merges each group's repeated cells into one cell
// spanning its questions.
//
// A group answers one verdict from several fact questions, and Inputs.table can only render flat
// rows - so C1's three rows each repeated "INSTRUCTION ADHERENCE" and "YES (3/3)". Reading down the
// column, that looks like three separate verdicts that happen to agree, which is the opposite of
// what the rubric says: there is one verdict per group, and the questions are its evidence. Spanning
// the cell states that in the table's own structure.
//
// Safe as a one-time pass because these tables are built with sort disabled and every row
// materialized, so the body is never re-ordered or extended underneath it.
export function prepareRubricTable(node: HTMLElement): HTMLElement {
  const table = node.querySelector("table")
  const body = table?.querySelector("tbody")
  if (!table || !body) {
    return node
  }

  // Located by header text rather than by a fixed index: Inputs.table emits a leading spacer cell,
  // and a hard-coded position silently points one column off the moment that changes.
  const headers = [...(table.querySelector<HTMLTableRowElement>("thead tr")?.cells ?? [])]

  // Labelled before anything is merged, while every row still has every cell in the same position.
  headers.forEach((header, index) => {
    const columnClass: string | undefined = RUBRIC_COLUMN_CLASSES[header.textContent?.trim() ?? ""]
    if (!columnClass) {
      return
    }

    header.classList.add(columnClass)
    for (const row of body.rows) {
      row.cells[index]?.classList.add(columnClass)
    }
  })

  const columns = ["Group", "Group result"]
    .map((label) => headers.findIndex((cell) => cell.textContent.trim() === label))
    .filter((index) => index >= 0)
  if (columns.length === 0) {
    return node
  }

  const groupOf = (row: HTMLTableRowElement): string | undefined =>
    columns[0] === undefined ? undefined : row.cells[columns[0]]?.textContent?.trim()
  let anchor: HTMLTableRowElement | null = null
  let span = 0

  const closeRun = () => {
    if (anchor && span > 1) {
      for (const index of columns) {
        const cell = anchor.cells[index]
        if (cell) cell.rowSpan = span
      }
    }
  }

  for (const row of [...body.rows]) {
    if (anchor && groupOf(row) === groupOf(anchor)) {
      span += 1
      // Removed last-to-first so each removal cannot shift an index still to be used.
      for (const index of [...columns].reverse()) {
        row.cells[index]?.remove()
      }
      continue
    }

    closeRun()
    anchor = row
    span = 1
  }

  closeRun()
  return node
}

// enableRowSelection makes the whole row a click target for its own checkbox. The checkbox is a
// 13px square at the far left of a row whose content runs the width of the page, so hitting it means
// aiming at the one part of the row that is hardest to hit - and on a touch screen it is below the
// recommended target size outright.
//
// Delegated on the table rather than bound per row, so it survives Inputs.table re-rendering its
// body, and it dispatches input *and* change: Inputs.table reads its value from input events, and
// the CSS that tints the row keys off :checked, so a silent .checked assignment would move the tint
// without moving the input's value.
export function enableRowSelection(node: HTMLElement): HTMLElement {
  const table = node.querySelector("table")
  if (!table) {
    return node
  }

  table.addEventListener("click", (event: MouseEvent) => {
    // The control itself already toggles; handling it here as well would toggle twice and land back
    // where it started. Links and buttons inside a cell keep their own behavior.
    // A click's target is an EventTarget, which has no DOM traversal of its own; narrowing it once
    // here is what lets both lookups below run.
    const target = event.target instanceof Element ? event.target : null
    if (!target || target.closest("input, a, button, label")) {
      return
    }

    // A click that ends a text selection is someone copying a fact question, not choosing a row.
    if (window.getSelection()?.toString()) {
      return
    }

    const checkbox = target.closest("tbody tr")?.querySelector<HTMLInputElement>("input[type=checkbox]")
    if (!checkbox) {
      return
    }

    // Forward the click to the checkbox rather than setting .checked and announcing it. Inputs.table
    // wires every row checkbox with `input.onclick = reselect`, and that handler owns the selection
    // set, the header checkbox's checked/indeterminate state, and the table's own value. Assigning
    // .checked moves the tick and the :checked tint while none of that bookkeeping runs - the row
    // looks selected, the header stays blank, and the value the table reports omits the row. A click
    // dispatched on a checkbox performs its activation behavior, so the toggle is still native.
    //
    // shiftKey and detail are carried over so a shift-click on a row extends the range exactly as a
    // shift-click on the checkbox does, and so reselect's blur-on-real-click still fires.
    checkbox.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      shiftKey: event.shiftKey,
      detail: event.detail,
    }))
  })

  return node
}
