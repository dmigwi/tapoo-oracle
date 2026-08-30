---
title: Tapoo Oracle
toc: false
---

```js
import {
  analyzeLogText,
  diagnosticRows,
  groupRows,
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
  <div class="signal-panel" aria-label="Oracle analysis pipeline">
    <span>agent-api log</span>
    <span>validate contract</span>
    <span>answer rubric</span>
    <span>report profile</span>
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
const groupTable = (rows, count) =>
  Inputs.table(rows, {
    columns: ["id", "group", "verdict", "evidence", "questions"],
    header: {id: "ID", group: "Group", verdict: "Verdict", evidence: "Answered", questions: "Questions"},
    width: {group: 260, questions: 220},
    sort: false,
    rows: count
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
  : html`<div>
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
  : html`<div>
      <section class="events-section">
        <h2>Capabilities</h2>
        <p class="section-note">AND semantics: every question in a group must answer YES for the group to be demonstrated.</p>
        ${groupTable(groupRows(result.report.capabilities), 9)}
      </section>
      <section class="events-section">
        <h2>Violations</h2>
        <p class="section-note">OR semantics: any question answering YES confirms the violation.</p>
        ${groupTable(groupRows(result.report.violations), 6)}
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
          Answers come from the rubric engine in this repository, against the
          <a href="https://github.com/dmigwi/tapoo-oracle/blob/main/docs/TAPOO_AGENTIC_BEHAVIOR_RUBRIC.md">Tapoo Agentic Behavior Rubric</a>.
        </p>
      </section>
    </div>`;
```

${notices}

${profile}

${detail}

<style>
:root {
  --oracle-ink: #15201f;
  --oracle-muted: #64706d;
  --oracle-paper: #f6f2e8;
  --oracle-line: #d8d0c1;
  --oracle-teal: #167c80;
  --oracle-amber: #b66a00;
  --oracle-rose: #b8403c;
}

body {
  background:
    linear-gradient(120deg, rgba(22, 124, 128, 0.12), transparent 32rem),
    radial-gradient(circle at 86% 8%, rgba(182, 106, 0, 0.16), transparent 24rem),
    var(--oracle-paper);
  color: var(--oracle-ink);
}

.oracle-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(260px, 0.75fr);
  gap: 2rem;
  align-items: end;
  margin: 1.5rem 0 2rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--oracle-line);
}

.eyebrow {
  margin: 0 0 0.75rem;
  color: var(--oracle-teal);
  font: 700 0.78rem/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-transform: uppercase;
}

.oracle-hero h1 {
  max-width: 10ch;
  margin: 0;
  font-size: clamp(3.2rem, 12vw, 8rem);
  line-height: 0.9;
}

.lede {
  max-width: 58rem;
  margin: 1.25rem 0 0;
  color: var(--oracle-muted);
  font-size: 1.08rem;
  line-height: 1.65;
}

.signal-panel {
  display: grid;
  gap: 0.5rem;
  padding: 1rem;
  border: 1px solid var(--oracle-line);
  background: rgba(255, 255, 255, 0.56);
}

.signal-panel span {
  padding: 0.72rem 0.85rem;
  border-left: 4px solid var(--oracle-teal);
  background: #fffaf0;
  font: 700 0.82rem/1.1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-transform: uppercase;
}

.analysis-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
  margin: 1.5rem 0;
}

.metric,
.oracle-summary,
.events-section,
.notice {
  border: 1px solid var(--oracle-line);
  background: rgba(255, 255, 255, 0.7);
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
.metric-teal { border-top: 4px solid var(--oracle-teal); }
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

.section-note {
  max-width: 68rem;
  margin: -0.4rem 0 1rem;
  color: var(--oracle-muted);
  font-size: 0.9rem;
}

.source-line,
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
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
}

@media (max-width: 860px) {
  .oracle-hero,
  .analysis-strip {
    grid-template-columns: 1fr;
  }

  .oracle-hero h1 {
    font-size: clamp(3rem, 18vw, 5rem);
  }
}
</style>
