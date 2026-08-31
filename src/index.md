---
title: Tapoo Oracle
toc: false
---

```js
import {
  analyzeLogText,
  diagnosticRows,
  rubricQuestionRows,
  narrativeSummary,
  profileCards,
  provenanceRows
} from "./components/oracle.js";
```

<section class="oracle-hero">
  <div>
    <p class="eyebrow">Tapoo analytics extension</p>
    <h1>Tapoo Oracle</h1>
    <p class="lede">Load a downloaded Tapoo <code>agent-api</code> log and read the agent's behavior profile: nine capability groups and six violation groups, answered strictly YES or NO from logged evidence. Not a scorecard &mdash; no combined intelligence score is produced.</p>
  </div>
</section>

```js
const sampleText = await FileAttachment("./analysis/fixtures/sample-agent-api-log.json").text();
```

```js
const upload = view(Inputs.file({
  label: "Downloaded log",
  accept: ".json",
  description: "The JSON file Tapoo's browser Logs panel downloads after an agent-api round."
}));
```

```js
const pasted = view(Inputs.textarea({
  label: "…or paste JSON",
  placeholder: "Paste a Tapoo agent-api log export here to override the file above.",
  rows: 6,
  resize: "vertical",
  spellcheck: false,
  monospace: true
}));
```

```js
// Precedence is pasted text, then an uploaded file, then the bundled sample, so the page always has
// something real to render and never shows an empty analysis as if it were a result.
const source = pasted?.trim()
  ? {text: pasted, label: "pasted log"}
  : upload
    ? {text: await upload.text(), label: upload.name}
    : {text: sampleText, label: "sample-agent-api-log.json (bundled reference export)"};

const result = analyzeLogText(source.text, {label: source.label});
```

```js
// Every conditional section is built here rather than in a markdown ${...} wrapper. Observable
// evaluates a block-level expression only when it is a single line: a multi-line ternary around an
// html`` template leaks its source onto the page as literal text while still rendering the HTML
// inside it, which looks close enough to correct to survive review.
const rubricTable = (rows) =>
  Inputs.table(rows, {
    columns: ["id", "group", "question", "answer", "groupResult"],
    header: {id: "ID", group: "Group", question: "Fact question", answer: "Answer", groupResult: "Group result"},
    width: {group: 220, question: 620, answer: 90, groupResult: 130},
    sort: false,
    rows: rows.length
  });

const notices = !result.ok
  ? html`<section class="notice notice-error">
      <strong>Cannot analyze this input</strong>
      <span>${result.error}</span>
    </section>`
  : result.warnings.length > 0
    ? html`<section class="notice notice-warn">
        <strong>Read with care</strong>
        <ul>${result.warnings.map((warning) => html`<li>${warning}</li>`)}</ul>
      </section>`
    : "";

const profile = !result.ok
  ? ""
  : html`<div class="report-region">
      <p class="source-line">Analyzing <strong>${source.label}</strong></p>
      <section class="analysis-strip">
        ${profileCards(result.report).map(
          (card) => html`<article class=${`metric metric-${card.tone}`}>
            <span>${card.label}</span>
            <strong>${card.value}</strong>
          </article>`
        )}
      </section>
      <section class="oracle-summary">
        <h2>Behavior Profile</h2>
        <p>${narrativeSummary(result.report)}</p>
      </section>
    </div>`;

const detail = !result.ok
  ? ""
  : html`<div class="report-region">
      <details class="events-section methodology-section">
        <summary>
          <span class="methodology-title" role="heading" aria-level="2">How this report is generated</span>
          <span class="methodology-preview">Five stages from the selected log to an evidence-based profile.</span>
        </summary>
        <div class="methodology-content">
          <p class="methodology-intro">
            Tapoo Oracle analyzes the selected log entirely in this browser. It does not upload the
            file, infer missing fields, or assign a combined intelligence score.
          </p>
          <ol class="analysis-pipeline">
            <li>
              <h3>Read the selected source</h3>
              <p>
                Pasted JSON takes precedence over an uploaded file. When neither is supplied, the
                bundled reference export keeps the report demonstrable without presenting an empty
                analysis as a result.
              </p>
            </li>
            <li>
              <h3>Validate the Tapoo log contract</h3>
              <p>
                The input must be valid JSON with the Tapoo export identity, an <code>entries</code>
                array, and readable log entries. A non-<code>agent-api</code> mode, missing build
                version, or skipped malformed entries produces a visible warning instead of being
                silently ignored.
              </p>
            </li>
            <li>
              <h3>Build evidence from recorded events</h3>
              <p>
                The rubric engine reads the validated entries in their recorded order and derives
                only contract-defined facts. Missing evidence answers <strong>NO</strong>, meaning the
                behavior was not observed in this sample, not that the model is incapable of it.
              </p>
            </li>
            <li>
              <h3>Answer and aggregate the rubric</h3>
              <p>
                Every rubric question returns <strong>YES</strong> or <strong>NO</strong>. A capability
                is demonstrated only when every question in its group is YES. A violation is confirmed
                when any question in its group is YES. The report keeps fractions such as
                <code>2/3</code> visible so partial evidence is not hidden by the group verdict. Each
                exact question and its answer are displayed directly in the report below.
              </p>
            </li>
            <li>
              <h3>Present the profile with its boundaries</h3>
              <p>
                Capability and violation totals remain separate. Operational failures that may come
                from provider infrastructure are reported as diagnostics, while build, model, player,
                and log metadata are retained as provenance for the analyzed sample.
              </p>
            </li>
          </ol>
        </div>
      </details>
      <section class="events-section">
        <h2>Capabilities</h2>
        <p class="section-note">AND semantics: every fact question must answer YES for its group to be demonstrated.</p>
        ${rubricTable(rubricQuestionRows(result.report.capabilities))}
      </section>
      <section class="events-section">
        <h2>Violations</h2>
        <p class="section-note">OR semantics: any fact question answering YES confirms its violation group.</p>
        ${rubricTable(rubricQuestionRows(result.report.violations))}
      </section>
      <section class="events-section">
        <h2>Operational Diagnostics</h2>
        <p class="section-note">Endpoint failures are excluded from the violation profile: they can be caused by infrastructure outside the model's reasoning behavior.</p>
        ${Inputs.table(diagnosticRows(result.report), {
          columns: ["signal", "count", "scored"],
          header: {signal: "Signal", count: "Count", scored: "Scored as"},
          sort: false,
          rows: 4
        })}
      </section>
      <section class="events-section">
        <h2>Provenance</h2>
        <p class="section-note">A profile is only meaningful against the build and round it was measured from.</p>
        ${Inputs.table(provenanceRows(result.source, result.report), {
          columns: ["field", "value"],
          header: {field: "Field", value: "Value"},
          sort: false,
          rows: 6
        })}
        <p class="source-line">
          The question definitions and answers above come directly from the rubric engine that
          analyzed this log.
        </p>
      </section>
    </div>`;
```

${notices}

${profile}

${detail}

<style>
:root {
  color-scheme: light;
  --oracle-display: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  --oracle-body: "Avenir Next", Avenir, "Segoe UI", sans-serif;
  --oracle-mono: "SFMono-Regular", Menlo, Consolas, monospace;
  --oracle-ink: #171717;
  --oracle-muted: #675448;
  --oracle-paper: #fbf4e8;
  --oracle-surface: #fffaf2;
  --oracle-line: #cfbdab;
  --oracle-sage: #42664f;
  --oracle-terracotta: #a3472d;
  --oracle-amber: #855711;
  --oracle-rose: #963c37;
  --theme-background: var(--oracle-paper);
  --theme-background-alt: var(--oracle-surface);
  --theme-foreground: var(--oracle-ink);
  --theme-foreground-alt: var(--oracle-ink);
  --theme-foreground-muted: var(--oracle-muted);
  --theme-foreground-focus: #8e3d28;
  --sans-serif: var(--oracle-body);
  --serif: var(--oracle-display);
  --monospace: var(--oracle-mono);
}

body {
  background: var(--oracle-paper);
  color: var(--oracle-ink);
  font-family: var(--oracle-body);
}

h1,
h2,
h3 {
  color: var(--oracle-ink);
  font-family: var(--oracle-display);
}

a[href] {
  color: var(--oracle-terracotta);
  text-decoration-color: rgba(163, 71, 45, 0.45);
  text-underline-offset: 0.16em;
}

.oracle-header-label {
  font: 700 0.8rem/1.2 var(--oracle-body);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.oracle-hero {
  margin: 1.5rem 0 2rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--oracle-line);
}

.eyebrow {
  margin: 0 0 0.75rem;
  color: var(--oracle-sage);
  font: 700 0.78rem/1.2 var(--oracle-body);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.oracle-hero h1 {
  max-width: 10ch;
  margin: 0;
  color: var(--oracle-ink);
  font-size: clamp(2.8rem, 7vw, 5.25rem);
  font-weight: 700;
  letter-spacing: -0.045em;
  line-height: 0.9;
}

.lede {
  max-width: 58rem;
  margin: 1.25rem 0 0;
  color: var(--oracle-muted);
  font-size: 1.08rem;
  line-height: 1.65;
}

.analysis-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
  margin: 1.5rem 0;
}

#observablehq-main > p:has(> .report-region),
.report-region {
  width: 100%;
  max-width: none;
}

#observablehq-main > p:has(> .report-region) {
  margin-right: 0;
}

.metric,
.oracle-summary,
.events-section,
.notice {
  border: 1px solid var(--oracle-line);
  background: var(--oracle-surface);
}

.metric {
  padding: 1rem;
}

.metric span {
  display: block;
  color: var(--oracle-muted);
  font-size: 0.86rem;
}

.metric strong {
  display: block;
  margin-top: 0.25rem;
  font-size: 2.4rem;
  line-height: 1;
}

.metric-ink { border-top: 4px solid var(--oracle-ink); }
.metric-teal { border-top: 4px solid var(--oracle-sage); }
.metric-rose { border-top: 4px solid var(--oracle-rose); }

.oracle-summary,
.events-section,
.notice {
  padding: 1.2rem;
  margin: 1.5rem 0;
}

.oracle-summary h2,
.events-section h2 {
  margin-top: 0;
}

.oracle-summary p {
  max-width: 68rem;
  font-size: 1.08rem;
  line-height: 1.65;
}

.methodology-intro {
  max-width: 68rem;
  line-height: 1.65;
}

.methodology-section summary {
  cursor: pointer;
}

.methodology-section summary::marker {
  color: var(--oracle-sage);
}

.methodology-title,
.methodology-preview {
  display: block;
}

.methodology-title {
  margin-bottom: 0.35rem;
  font: 700 1.5rem/1.15 var(--oracle-display);
}

.methodology-preview {
  color: var(--oracle-muted);
  font-size: 0.9rem;
}

.methodology-content {
  margin-top: 1.2rem;
}

.analysis-pipeline {
  max-width: none;
  margin: 1.5rem 0;
  padding: 0;
  list-style: none;
  counter-reset: analysis-step;
}

.analysis-pipeline li {
  position: relative;
  padding: 1rem 0 1rem 3.5rem;
  border-top: 1px solid var(--oracle-line);
  counter-increment: analysis-step;
}

.analysis-pipeline li:last-child {
  border-bottom: 1px solid var(--oracle-line);
}

.analysis-pipeline li::before {
  position: absolute;
  top: 1rem;
  left: 0;
  color: var(--oracle-sage);
  content: counter(analysis-step, decimal-leading-zero);
  font: 700 0.8rem/1.4 var(--oracle-body);
}

.analysis-pipeline h3 {
  margin: 0 0 0.35rem;
  font-size: 1.1rem;
}

.analysis-pipeline p {
  max-width: 68rem;
  margin: 0;
  line-height: 1.6;
}

.section-note {
  max-width: 68rem;
  margin: -0.4rem 0 1rem;
  color: var(--oracle-muted);
  font-size: 0.9rem;
}

.source-line {
  color: var(--oracle-muted);
  font-size: 0.9rem;
}

.source-line {
  margin-bottom: 0;
}


.notice {
  display: grid;
  gap: 0.4rem;
}

.notice ul {
  margin: 0;
  padding-left: 1.1rem;
}

.notice-error {
  border-color: var(--oracle-rose);
  color: var(--oracle-rose);
}

.notice-warn {
  border-color: var(--oracle-amber);
  color: var(--oracle-amber);
}

textarea {
  min-height: 8rem;
  border: 1px solid var(--oracle-line);
  border-radius: 0.25rem;
  background: var(--oracle-surface);
  color: var(--oracle-ink);
  font-family: var(--oracle-mono) !important;
}

input,
button,
select,
textarea {
  accent-color: var(--oracle-terracotta);
}

button,
input[type="file"]::file-selector-button {
  border: 1px solid #aa8c76;
  border-radius: 0.25rem;
  background: #f3e4d2;
  color: var(--oracle-ink);
  font-family: var(--oracle-body);
}

table {
  max-width: none;
  font-family: var(--oracle-body);
}

th {
  color: var(--oracle-ink);
}

td {
  color: var(--oracle-ink);
}

@media (max-width: 860px) {
  .analysis-strip {
    grid-template-columns: 1fr;
  }

  .oracle-hero h1 {
    font-size: clamp(2.6rem, 13vw, 4rem);
  }
}
</style>
