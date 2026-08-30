// Adapter between Tapoo's vendored rubric engine and this app's views.
//
// The analysis itself is not implemented here. It lives in src/vendor/tapoo-analysis, copied
// verbatim from Tapoo, so that this app and `make agentic-analysis` cannot answer the same question
// about the same log differently. Everything below is presentation: turning one engine result into
// rows, cards, and sentences.
//
// The rule this file follows is that nothing it displays may be invented. Every number traces to a
// rubric answer or to an explicitly logged event - no substring sniffing, no guessed field names, no
// signal that the contract does not define. A plausible-looking number with no basis in the log is
// worse than an absent one, because it still reads as evidence.

import { parseTapooLogExport } from "../vendor/tapoo-analysis/log-contract.js";
import { answerRubric } from "../vendor/tapoo-analysis/rubric-engine.js";

// analyzeLogText is the single entry point from raw text to a rendered result. It returns a
// discriminated result instead of throwing, because every failure here is a person's input mistake
// that the page has to explain, not an exceptional condition.
export function analyzeLogText(text, {label = "pasted log"} = {}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return {ok: false, error: "Load or paste a Tapoo agent-api log to begin."};
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {ok: false, error: `Not valid JSON: ${error.message}`};
  }

  const result = parseTapooLogExport(parsed);
  if (!result.ok) {
    return {ok: false, error: result.error};
  }

  return {
    ok: true,
    source: result.value,
    warnings: result.warnings,
    report: answerRubric(result.value.entries, {label})
  };
}

// profileCards summarizes a report as headline counts.
//
// Capabilities and violations are reported as separate fractions and never combined. The rubric is
// explicit that they must not collapse into one score interval: a model with six capabilities and
// two violations is not "four", and any arithmetic that produces a single number here would be
// inventing a scale the contract deliberately refuses to define.
export function profileCards(report) {
  const met = (groups) => groups.filter((group) => group.met).length;

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

// groupRows renders one rubric group per row, keeping every per-question answer visible beside the
// verdict. The fraction is carried because partial evidence is not the same as none: C7 at 1/2 and
// C7 at 0/2 are both a `no`, and showing only the verdict would hide exactly the difference the
// rubric asks to preserve.
export function groupRows(groups) {
  return groups.map((group) => ({
    id: group.id,
    group: group.label,
    verdict: group.met ? "YES" : "no",
    evidence: `${group.passed}/${group.total}`,
    questions: Object.entries(group.answers)
      .map(([question, answer]) => `${question}:${answer ? "Y" : "n"}`)
      .join("  ")
  }));
}

// diagnosticRows reports operational signals that are deliberately excluded from the violation
// profile. Endpoint failures in particular can be caused by infrastructure outside the model's
// reasoning, so the rubric notes require them to be preserved as evidence but never scored.
export function diagnosticRows(report) {
  return [
    {signal: "Endpoint failures", count: report.diagnostics.endpointFailures, scored: "no"},
    {signal: "Empty responses", count: report.diagnostics.emptyResponses, scored: "V2.Q2"},
    {signal: "Unparseable responses", count: report.diagnostics.unparseableResponses, scored: "V2.Q1"},
    {signal: "Token cap exhaustions", count: report.diagnostics.tokenExhaustions, scored: "V5.Q3"}
  ];
}

// provenanceRows describe which build and which round produced the log, so a profile is never read
// detached from what it was measured against.
export function provenanceRows(source, report) {
  return [
    {field: "Tapoo version", value: source.version ?? "not recorded"},
    {field: "Control mode", value: source.mode ?? "not recorded"},
    {field: "Downloaded at", value: source.downloadedAt ?? "not recorded"},
    {field: "Log entries", value: formatCount(source.entries.length)},
    {field: "Model", value: report.model ?? "not recorded"},
    {field: "Player", value: report.player ?? "not recorded"}
  ];
}

// narrativeSummary states the profile in a sentence, and says plainly what a "no" means. Readers
// reliably over-read a negative rubric answer as a claim about the model's ability, which it never
// is - it says the behavior was not observed in this one sample.
export function narrativeSummary(report) {
  const capabilities = report.capabilities.filter((group) => group.met).map((group) => group.id);
  const violations = report.violations.filter((group) => group.met).map((group) => group.id);
  const speed = report.traversalSpeedClass
    ? `Winning traversal speed ${report.traversalSpeed.toFixed(4)} (${report.traversalSpeedClass}).`
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

function formatCount(value) {
  return Number(value).toLocaleString("en-US");
}
