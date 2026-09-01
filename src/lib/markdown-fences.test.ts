import {readFileSync, readdirSync} from "node:fs"
import {join} from "node:path"

import {describe, expect, it} from "vitest"

// The one surface no checker can see.
//
// Observable puts JavaScript in fenced blocks inside markdown, and nothing type-checks those: not
// tsc, whose `include` is src/**/*.ts; not ESLint, for the same reason; not Observable, which only
// transpiles. Every other line in this app is checked, so a fence is where an unchecked mistake can
// hide - and the more logic that lives there, the more of the app is outside the guarantee the
// TypeScript conversion was for.
//
// This does not check the fences. It keeps them small enough that reading them is enough, which is a
// claim a test can actually make. A fence that grows past these bounds is a prompt to move the logic
// into a module, where it is checked, and call it from the page.

const PAGES = "src"

const fencesIn = (markdown: string): string[] =>
  [...markdown.matchAll(/^```js\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? "")

// Statements, ignoring comments and blank lines - the fences are commented on purpose, and a comment
// is the opposite of the thing being bounded.
const statementsIn = (fence: string): string[] =>
  fence
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"))

const markdownPages: string[] = readdirSync(PAGES).filter((name) => name.endsWith(".md"))

describe("markdown fences", () => {
  it("finds the pages it is meant to be guarding", () => {
    // Renaming or moving a page would otherwise make this whole file pass by matching nothing.
    expect(markdownPages.sort()).toEqual(["404.md", "index.md"])
  })

  it.each(markdownPages)("keeps %s to imports and a handful of calls", (page: string) => {
    const fences = fencesIn(readFileSync(join(PAGES, page), "utf8"))
    expect(fences.length).toBeGreaterThan(0)

    const statements = fences.flatMap(statementsIn)

    // Eight is roughly twice what the pages hold today, so ordinary edits do not trip it while a
    // block of logic migrating back into the page does.
    expect(statements.length).toBeLessThanOrEqual(8)

    // No control flow. A fence that branches or loops is doing work, and work belongs in a module.
    for (const statement of statements) {
      expect(statement).not.toMatch(/^(if|for|while|switch|try|function|class)\b/)
    }
  })

  it("imports the app through its single entry", () => {
    const imports = fencesIn(readFileSync(join(PAGES, "index.md"), "utf8"))
      .flatMap(statementsIn)
      .filter((statement) => statement.startsWith("import "))

    // One specifier, and it names the bundle scripts/build.mjs writes beside the page. Observable
    // resolves this one itself, so it keeps the .js extension its resolver requires - unlike the
    // extensionless specifiers inside src/lib, which esbuild resolves before Observable sees them.
    expect(imports).toHaveLength(1)
    expect(imports[0]).toContain('from "./app.js"')
  })
})

describe("index.md regions", () => {
  const page = readFileSync(join(PAGES, "index.md"), "utf8")

  it("interpolates every region renderReportSections returns, and nothing else", () => {
    // A region added to the module but never interpolated renders nowhere, and an interpolation naming
    // a region that no longer exists prints "undefined" to the reader. Neither fails anywhere else.
    const interpolated = [...page.matchAll(/\$\{report\.(\w+)\}/g)].map((match) => match[1])

    expect(interpolated).toEqual(["emptyState", "notices", "methodology", "profile", "detail"])
  })

  it("puts the methodology above the profile it describes", () => {
    // A reader deciding whether to trust a profile - or whether to pass its link on - asks how it was
    // made before reading its verdicts.
    expect(page.indexOf("${report.methodology}")).toBeGreaterThan(page.indexOf("${report.notices}"))
    expect(page.indexOf("${report.methodology}")).toBeLessThan(page.indexOf("${report.profile}"))
  })

  it("holds no methodology markup of its own", () => {
    // It lived here as static markup for a while. Leaving a copy behind would put two on the page.
    expect(page).not.toContain("methodology-section")
  })
})
