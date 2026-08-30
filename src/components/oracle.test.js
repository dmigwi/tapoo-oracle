import { describe, expect, it } from "vitest"

import fixture from "../vendor/tapoo-analysis/fixtures/sample-agent-api-log.json"
import {
  analyzeLogText,
  diagnosticRows,
  groupRows,
  narrativeSummary,
  profileCards,
  provenanceRows,
} from "./oracle.js"

const fixtureText = JSON.stringify(fixture)

describe("analyzeLogText", () => {
  it("analyzes a real Tapoo export", () => {
    const result = analyzeLogText(fixtureText, { label: "fixture" })

    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([])
    expect(result.report.model).toBe("test-model")
    expect(result.report.capabilities).toHaveLength(9)
    expect(result.report.violations).toHaveLength(6)
  })

  it("explains an empty input rather than failing silently", () => {
    expect(analyzeLogText("   ")).toEqual({
      ok: false,
      error: "Load or paste a Tapoo agent-api log to begin.",
    })
  })

  it("reports malformed JSON", () => {
    const result = analyzeLogText("{not json")
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^Not valid JSON:/)
  })

  // The previous analyzer accepted any JSON and inferred "events" from guessed key names, so an
  // unrelated payload produced a confident-looking profile of nothing. Rejecting non-Tapoo input is
  // the behavior that replaced it, and it is worth a test of its own.
  it("rejects JSON that is not a Tapoo export", () => {
    const result = analyzeLogText(JSON.stringify({ turns: [{ action: "move", status: "applied" }] }))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Not a Tapoo log export/)
  })

  it("surfaces contract warnings without refusing the log", () => {
    const result = analyzeLogText(JSON.stringify({ ...fixture, mode: "human" }))
    expect(result.ok).toBe(true)
    expect(result.warnings.join(" ")).toMatch(/not "agent-api"/)
  })
})

describe("presentation", () => {
  const { report, source } = analyzeLogText(fixtureText, { label: "fixture" })

  it("keeps capabilities and violations as separate fractions", () => {
    const cards = profileCards(report)
    expect(cards[0]).toMatchObject({ label: "Capabilities demonstrated", value: "7/9" })
    expect(cards[1]).toMatchObject({ label: "Violations confirmed", value: "0/6" })

    // The rubric forbids collapsing the two into one score interval.
    expect(cards.map((card) => card.label)).not.toContain("Score")
  })

  it("keeps partial evidence visible beside a negative verdict", () => {
    const structural = groupRows(report.capabilities).find((row) => row.id === "C7")
    expect(structural.verdict).toBe("no")
    expect(structural.evidence).toBe("1/2")
    expect(structural.questions).toBe("Q1:n  Q2:Y")
  })

  it("marks endpoint failures as unscored", () => {
    const endpoint = diagnosticRows(report).find((row) => row.signal === "Endpoint failures")
    expect(endpoint.scored).toBe("no")
  })

  it("describes provenance without inventing missing fields", () => {
    const rows = provenanceRows(source, report)
    expect(rows.find((row) => row.field === "Tapoo version").value).toBe("2.5.0")

    const withoutVersion = analyzeLogText(JSON.stringify({ ...fixture, version: undefined }))
    const missing = provenanceRows(withoutVersion.source, withoutVersion.report)
    expect(missing.find((row) => row.field === "Tapoo version").value).toBe("not recorded")
  })

  it("states what a negative answer does and does not mean", () => {
    const summary = narrativeSummary(report)
    expect(summary).toMatch(/7 of 9 capabilities/)
    expect(summary).toMatch(/Trailblazer/)
    expect(summary).toMatch(/not that the model is incapable/)
  })
})
