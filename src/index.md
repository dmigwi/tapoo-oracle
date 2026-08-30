---
title: Tapoo Oracle
toc: false
---

```js
import {
  analyzePayload,
  formatDatumLabel,
  metricCards,
  narrativeSummary,
  parsePayload,
  samplePayloadText,
  tableRows
} from "./components/oracle.js";
```

<section class="oracle-hero">
  <div>
    <p class="eyebrow">Tapoo extension</p>
    <h1>Tapoo Oracle</h1>
    <p class="lede">Paste raw Agent behavior profiler JSON from Tapoo and turn it into an operational readout: detected events, dominant behaviors, warning signals, backtracking references, and a compact audit trail.</p>
  </div>
  <div class="signal-panel" aria-label="Oracle analysis loop">
    <span>raw json</span>
    <span>normalize</span>
    <span>profile</span>
    <span>illustrate</span>
  </div>
</section>

```js
const rawPayload = view(Inputs.textarea({
  label: "Raw Tapoo profiler JSON",
  value: samplePayloadText,
  rows: 16,
  resize: "vertical",
  spellcheck: false,
  monospace: true
}));
```

```js
const parsed = parsePayload(rawPayload);
const analysis = parsed.ok ? analyzePayload(parsed.value) : null;
```

${parsed.ok ? html`
  <section class="analysis-strip">
    ${metricCards(analysis).map((card) => html`
      <article class=${`metric metric-${card.tone}`}>
        <span>${card.label}</span>
        <strong>${card.value}</strong>
      </article>
    `)}
  </section>
` : html`
  <section class="parse-error">
    <strong>JSON parse failed</strong>
    <span>${parsed.error}</span>
  </section>
`}

${parsed.ok ? html`
  <section class="oracle-summary">
    <h2>Behavior Summary</h2>
    <p>${narrativeSummary(analysis)}</p>
    <dl>
      <div><dt>Payload shape</dt><dd>${analysis.shape}</dd></div>
      <div><dt>Root keys</dt><dd>${analysis.rootKeys.length ? analysis.rootKeys.join(", ") : "none"}</dd></div>
    </dl>
  </section>
` : ""}

```js
function barChart(data, title, color, {width} = {}) {
  if (!data.length) return html`<div class="empty-chart">No values detected.</div>`;
  return Plot.plot({
    title,
    width,
    height: Math.max(220, data.length * 34 + 48),
    marginLeft: 118,
    marginRight: 24,
    x: {grid: true, label: "Events"},
    y: {label: null},
    marks: [
      Plot.ruleX([0]),
      Plot.barX(data, {x: "value", y: "key", fill: color, sort: {y: "-x"}, tip: {format: {y: false, x: true}}}),
      Plot.text(data, {x: "value", y: "key", text: formatDatumLabel, dx: 6, textAnchor: "start", fill: "var(--oracle-ink)"})
    ]
  });
}

function timelinePlot(data, {width} = {}) {
  if (!data.length) return html`<div class="empty-chart">No timestamped events detected.</div>`;
  return Plot.plot({
    title: "Timestamped behavior trail",
    width,
    height: 260,
    marginLeft: 56,
    x: {type: "time", grid: true, label: null},
    y: {grid: true, label: "Event", reverse: true},
    color: {legend: true},
    marks: [
      Plot.ruleY(data, {y: "index", stroke: "#e2e8f0"}),
      Plot.dot(data, {x: "timestamp", y: "index", fill: "status", r: 6, tip: true}),
      Plot.text(data, {x: "timestamp", y: "index", text: "action", dy: -12, fontSize: 11, lineWidth: 10})
    ]
  });
}
```

${parsed.ok ? html`
  <section class="chart-grid">
    <div class="chart-surface">${resize((width) => barChart(analysis.actionTypes, "Detected behavior types", "#167c80", {width}))}</div>
    <div class="chart-surface">${resize((width) => barChart(analysis.statuses, "Outcome and status signals", "#b66a00", {width}))}</div>
  </section>
  <section class="chart-surface wide">${resize((width) => timelinePlot(analysis.timeline, {width}))}</section>
` : ""}

${parsed.ok ? html`
  <section class="events-section">
    <h2>Profiler Event Rows</h2>
    ${Inputs.table(tableRows(analysis), {
      columns: ["#", "action", "status", "agent", "timestamp", "detail"],
      width: {detail: 520},
      header: {
        "#": "#",
        action: "Action",
        status: "Status",
        agent: "Agent",
        timestamp: "Timestamp",
        detail: "Detail"
      }
    })}
  </section>
` : ""}

<style>
:root {
  --oracle-ink: #15201f;
  --oracle-muted: #64706d;
  --oracle-paper: #f6f2e8;
  --oracle-line: #d8d0c1;
  --oracle-teal: #167c80;
  --oracle-amber: #b66a00;
  --oracle-rose: #b8403c;
  --oracle-green: #3e6f47;
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
  letter-spacing: 0;
  text-transform: uppercase;
}

.oracle-hero h1 {
  max-width: 10ch;
  margin: 0;
  font-size: clamp(3.2rem, 12vw, 8rem);
  line-height: 0.9;
  letter-spacing: 0;
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
  grid-template-columns: 1fr;
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

.analysis-strip,
.chart-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
  margin: 1.5rem 0;
}

.metric,
.oracle-summary,
.chart-surface,
.events-section,
.parse-error {
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
.metric-amber { border-top: 4px solid var(--oracle-amber); }
.metric-rose { border-top: 4px solid var(--oracle-rose); }

.oracle-summary,
.events-section,
.parse-error {
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

.oracle-summary dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
  margin: 1rem 0 0;
}

.oracle-summary dt {
  color: var(--oracle-muted);
  font-size: 0.82rem;
}

.oracle-summary dd {
  margin: 0.25rem 0 0;
  font-weight: 700;
}

.chart-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.chart-surface {
  min-height: 260px;
  padding: 0.8rem;
  overflow: hidden;
}

.chart-surface.wide {
  margin: 1rem 0;
}

.empty-chart {
  display: grid;
  min-height: 220px;
  place-items: center;
  color: var(--oracle-muted);
}

.parse-error {
  display: flex;
  gap: 0.75rem;
  border-color: var(--oracle-rose);
  color: var(--oracle-rose);
}

textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
}

@media (max-width: 860px) {
  .oracle-hero,
  .analysis-strip,
  .chart-grid,
  .oracle-summary dl {
    grid-template-columns: 1fr;
  }

  .oracle-hero h1 {
    font-size: clamp(3rem, 18vw, 5rem);
  }
}
</style>
