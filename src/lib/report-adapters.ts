// Turning a report into what the page shows: cards, rows, and sentences.
//
// Nothing here invents a number. Every value traces to a rubric answer or to a field the log states
// outright, which is why the adapters are pure and testable without a DOM.

import type { GroupKind, GroupResult, Report, TapooLog } from "./types"

export function formatCount(value: number | string): string {
  return Number(value).toLocaleString("en-US");
}

export function profileCards(report: Report): Array<{label: string; value: string; tone: string}> {
  const met = (groups: GroupResult[]): number => groups.filter((group) => group.met).length;

  return [
    {
      label: "Capabilities demonstrated",
      value: `${met(report.capabilities)}/${report.capabilities.length}`,
      tone: "teal"
    },
    {
      label: "Violations confirmed",
      value: `${met(report.violations)}/${report.violations.length}`,
      tone: "rose"
    },
    {label: "Predictions", value: formatCount(report.predictions), tone: "ink"},
    {label: "Rounds", value: formatCount(report.rounds), tone: "ink"}
  ];
}

// narrativeSummary states the profile in a sentence, and says plainly what a "no" means. Readers
// reliably over-read a negative rubric answer as a claim about the model's ability, which it never
// is - it says the behavior was not observed in this one sample.
export function narrativeSummary(report: Report): string {
  const capabilities = report.capabilities.filter((group) => group.met).map((group) => group.id);
  const violations = report.violations.filter((group) => group.met).map((group) => group.id);
  const speed =
    report.traversalSpeedClass !== null && Number.isFinite(report.traversalSpeed)
      ? `Winning traversal speed ${(report.traversalSpeed as number).toFixed(4)} (${report.traversalSpeedClass}).`
      : "No winning round in this sample.";

  return [
    `${report.model ?? "This agent"} demonstrated ${capabilities.length} of ${report.capabilities.length} capabilities`,
    capabilities.length ? `(${capabilities.join(", ")})` : "",
    `across ${formatCount(report.predictions)} prediction${report.predictions === 1 ? "" : "s"}.`,
    violations.length
      ? `Confirmed violations: ${violations.join(", ")}.`
      : "No violations confirmed.",
    speed,
    "A negative answer means the behavior was not observed in this sample, not that the model is incapable of it."
  ]
    .filter(Boolean)
    .join(" ");
}

// groupResultTone names the class a group result should carry, or null for no colour at all.
//
// Split out from the table's format callback because this is the part that can be wrong: YES means
// opposite things in the two tables, and the rule for what stays uncoloured is a statement about
// what the rubric claims. The span-wrapping around it cannot be, so the DOM stays in the view and
// the decision stays here where the suite can reach it.
export function groupResultTone(kind: GroupKind, groupResult: string): string | null {
  // NO is never coloured. For a violation it is the good outcome, and for a capability it means the
  // behavior was not observed in this sample - never that the model is incapable of it, which is the
  // one thing this report exists not to say. Red on that line would say it.
  if (!String(groupResult).startsWith("YES")) {
    return null
  }

  return kind === "violation" ? "result-confirmed" : "result-demonstrated"
}

// rubricQuestionRows gives every evaluated fact its own row. Group verdicts and fractions remain
// visible because a partially evidenced group and a group with no evidence can share the same NO.
export function rubricQuestionRows(groups: GroupResult[]): Array<Record<string, string>> {
  return groups.flatMap((group) =>
    Object.entries(group.answers).map(([questionId, answer]) => ({
      id: `${group.id}.${questionId}`,
      group: group.label,
      question: group.questions[questionId] ?? "",
      answer: answer ? "YES" : "NO",
      groupResult: `${group.met ? "YES" : "NO"} (${group.passed}/${group.total})`,
    })),
  )
}

// diagnosticRows reports operational signals that are deliberately excluded from the violation
// profile. Endpoint failures in particular can be caused by infrastructure outside the model's
// reasoning, so the rubric notes require them to be preserved as evidence but never scored.
export function diagnosticRows(report: Report): Array<{signal: string; count: number; scored: string}> {
  return [
    {signal: "Endpoint failures", count: report.diagnostics.endpointFailures, scored: "no"},
    {signal: "Empty responses", count: report.diagnostics.emptyResponses, scored: "V2.Q2"},
    {signal: "Unparseable responses", count: report.diagnostics.unparseableResponses, scored: "V2.Q1"},
    {signal: "Token cap exhaustions", count: report.diagnostics.tokenExhaustions, scored: "V5.Q3"}
  ];
}

// diagnosticTableData pivots the short diagnostic list into a wide comparison matrix. Keeping the
// two measures as rows avoids packing count and scoring semantics into an ambiguous combined value.
export function diagnosticTableData(report: Report): {columns: string[]; rows: Array<Record<string, unknown>>} {
  const diagnostics = diagnosticRows(report)
  const columns = ["measure", ...diagnostics.map((row) => row.signal)]

  return {
    columns,
    rows: [
      // Object.fromEntries on a heterogeneous array is `any`; the annotation is what keeps that from
      // becoming the declared row type.
      Object.fromEntries<unknown>([["measure", "Count"], ...diagnostics.map((row) => [row.signal, row.count] as const)]),
      Object.fromEntries<unknown>([["measure", "Scored as"], ...diagnostics.map((row) => [row.signal, row.scored] as const)]),
    ],
  }
}

// provenanceRows describe which build and which round produced the log, so a profile is never read
// detached from what it was measured against.
export function provenanceRows(source: TapooLog, report: Report): Array<{field: string; value: string}> {
  return [
    // No source URL row. It is the one field here that is not read out of the log itself, the panel
    // above already carries the share link that identifies the same log, and a table cell is the
    // most screenshotted place on the page to put an address that the rest of this change exists to
    // keep out of it. What remains is provenance the log vouches for.
    {field: "Tapoo version", value: source.version ?? "not recorded"},
    {field: "Control mode", value: source.mode ?? "not recorded"},
    {field: "Downloaded at", value: source.downloadedAt ?? "not recorded"},
    {field: "Log entries", value: formatCount(source.entries.length)},
    {field: "Model", value: report.model ?? "not recorded"},
    {field: "Player", value: report.player ?? "not recorded"}
  ];
}

// provenanceTableData renders the small provenance record as one horizontal row so a wide report
// does not spend six rows on six short values.
export function provenanceTableData(source: TapooLog, report: Report): {columns: string[]; rows: Array<Record<string, unknown>>} {
  const provenance = provenanceRows(source, report)
  return {
    columns: provenance.map((row) => row.field),
    rows: [Object.fromEntries(provenance.map((row) => [row.field, row.value]))],
  }
}
