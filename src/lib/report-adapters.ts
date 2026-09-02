// Turning a report into what the page shows: cards, rows, and sentences.
//
// Nothing here invents a number. Every value traces to a rubric answer or to a field the log states
// outright, which is why the adapters are pure and testable without a DOM.

import type { LogWarning, GroupKind, GroupResult, Report, TapooLog } from "./types"

// warningHeadline is the sentence a reader sees in bold above the caveats, or null when there are none.
//
// A warning is only shown when it costs the reader something, so the banner says what that cost is
// rather than asking them to work it out from a list. "Read with care" was the old heading and it did
// not do that: it is a tone, not a finding, and a reader cannot tell from it whether a verdict below
// is wrong or whether the report is merely missing its provenance.
//
// The two impacts are reported together when both are present, because they are different harms and
// collapsing them would understate one of them.
export function warningHeadline(warnings: LogWarning[]): string | null {
  const inaccurate = warnings.some((warning) => warning.impact === "inaccurate")
  const incomplete = warnings.some((warning) => warning.impact === "incomplete")

  if (inaccurate && incomplete) return "This report may be inaccurate and is missing important parts."
  if (inaccurate) return "This report may be inaccurate."
  if (incomplete) return "This report is missing important parts."
  return null
}

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

  // Named in the summary, not only in the provenance table: a reader quoting one sentence about this
  // agent should be quoting one that says what it was asked to do the work with.
  const setup = [
    report.apis.length > 0 ? `through ${report.apis.join(", ")}` : "",
    report.reasoningEfforts.length > 0 ? `at ${report.reasoningEfforts.join(", ")} reasoning effort` : "",
  ].filter(Boolean).join(" ");

  return [
    `${report.model ?? "This agent"}${setup ? `, ${setup},` : ""} demonstrated ${capabilities.length} of ${report.capabilities.length} capabilities`,
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
// Joined rather than reduced to one value: a log that names two providers really was produced against
// two, and picking one would misdescribe the sample.
function listOrNotRecorded(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "not recorded";
}

// modelOutputRows summarises what the model produced, as the provider itself reported it.
//
// Only rows the provider actually reported: the two APIs report overlapping but different things, and
// a row reading "not recorded" for every Ollama log would be a column of noise rather than a finding.
// The exception is the token counts, which both report and which are the point of the section.
//
// Nothing here is scored. It is context for reading the verdicts above - a model given 3,000 prompt
// tokens per turn and one given 300 are not doing the same task, and neither is a run that spent most
// of its completion budget on reasoning tokens.
// formatDuration reads a span of seconds the way a person would say it.
//
// The log counts nanoseconds, and a run of any length reported in seconds alone stops being legible
// somewhere around a minute: one real log spent 19,174 seconds, which is five and a third hours and
// reads as neither.
function formatDuration(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    return `${hours}h ${Math.round((seconds - hours * 3600) / 60)}m`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
  }
  // Below ten seconds two decimals still say something; above it they are noise.
  return seconds >= 10 ? `${seconds.toFixed(1)}s` : `${seconds.toFixed(2)}s`;
}

export function modelOutputRows(report: Report): Array<{field: string; value: string}> {
  const {output} = report;
  const rows: Array<{field: string; value: string}> = [
    {field: "Responses", value: formatCount(output.responses)},
  ];

  const tokens = (label: string, total: number | null): void => {
    if (total === null) return;
    // Per response as well as in total: a total is a function of how long the run was, and the average
    // is what compares one run to another.
    const each = output.responses > 0 ? Math.round(total / output.responses) : 0;
    rows.push({field: label, value: `${formatCount(total)} (${formatCount(each)} per response)`});
  };

  tokens("Prompt tokens", output.promptTokens);
  tokens("Completion tokens", output.completionTokens);
  tokens("Reasoning tokens", output.reasoningTokens);
  tokens("Cached prompt tokens", output.cachedPromptTokens);

  if (output.durationNs !== null) {
    // Total, then the per-response mean: a slow provider and a long run look identical in the total.
    const seconds = output.durationNs / 1e9;
    const each = output.responses > 0 ? seconds / output.responses : 0;
    rows.push({field: "Model time", value: `${formatDuration(seconds)} (${formatDuration(each)} per response)`});
  }

  if (output.finishReasons.length > 0) {
    // Named and counted rather than reduced to the most common one: "length" appearing at all means the
    // model was cut off mid-answer, and that is worth seeing even when it happened three times in 719.
    rows.push({
      field: "Finish reasons",
      value: output.finishReasons.map(([reason, count]) => `${reason} (${formatCount(count)})`).join(", "),
    });
  }

  return rows;
}

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
    // The same model answers differently through a different provider, and differently again at a
    // different reasoning effort. A verdict is only comparable to another taken under both, so neither
    // is an implementation detail worth leaving out of provenance.
    {field: "API provider", value: listOrNotRecorded(report.apis)},
    {field: "Reasoning effort", value: listOrNotRecorded(report.reasoningEfforts)},
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
