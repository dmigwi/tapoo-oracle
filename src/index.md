---
title: Tapoo Oracle
toc: false
---

```js
import {
  createInitialReportTabs,
  createReportTabsInput,
  diagnosticTableData,
  rubricQuestionRows,
  narrativeSummary,
  profileCards,
  provenanceTableData
} from "./components/oracle.js";
```

<section class="oracle-hero">
  <div>
    <h1>Tapoo Oracle</h1>
    <p class="lede">Load an online Tapoo <code>agent-api</code> JSON log URL and read the agent's behavior profile: nine capability groups and six violation groups, answered strictly YES or NO from logged evidence. Not a scorecard &mdash; no combined intelligence score is produced.</p>
  </div>
</section>

```js
const reportTabsState = view(createReportTabsInput());
```

```js
const normalizedReportTabsState = reportTabsState?.tabs ? reportTabsState : createInitialReportTabs();
const activeReportTab = normalizedReportTabsState.tabs.find(
  (tab) => tab.id === normalizedReportTabsState.activeTabId
) ?? normalizedReportTabsState.tabs[0];
const result = activeReportTab?.result;
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

const diagnosticsTable = (report) => {
  const data = diagnosticTableData(report);
  return Inputs.table(data.rows, {
    columns: data.columns,
    header: {measure: "Measure"},
    sort: false,
    rows: data.rows.length
  });
};

const provenanceTable = (source, report) => {
  const data = provenanceTableData(source, report);
  return Inputs.table(data.rows, {
    columns: data.columns,
    sort: false,
    rows: data.rows.length
  });
};

const emptyState = activeReportTab?.status === "loaded" || activeReportTab?.status === "error"
  ? ""
  : html`<section class="notice empty-report-state">
      <strong>Load an online JSON report URL</strong>
      <ol>
        <li>Enter an <code>http://</code> or <code>https://</code> URL.</li>
        <li>Use a Tapoo <code>agent-api</code> JSON log, then select <strong>Load report</strong>.</li>
        <li>Each report owns its URL and analysis; deleting a report removes both.</li>
      </ol>
      <div class="gist-help">
        <strong>Host a local JSON payload with GitHub Gist</strong>
        <ol>
          <li>Open <a href="https://gist.github.com">gist.github.com</a> while signed in to GitHub.</li>
          <li>Create a new gist, name the file with a <code>.json</code> extension, and paste or drag in the Tapoo log JSON.</li>
          <li>Create a secret gist for a share-by-link report, or a public gist only when the payload is safe to publish.</li>
          <li>Open the created gist file's <strong>Raw</strong> view and copy that <code>gist.githubusercontent.com</code> URL.</li>
          <li>Paste the raw URL into <strong>Online JSON file URL</strong>, then select <strong>Load report</strong>.</li>
        </ol>
      </div>
    </section>`;

const notices = activeReportTab?.status === "error"
  ? html`<section class="notice notice-error">
      <strong>Cannot analyze this URL</strong>
      <span>${activeReportTab.error}</span>
    </section>`
  : result?.ok && result.warnings.length > 0
    ? html`<section class="notice notice-warn">
        <strong>Read with care</strong>
        <ul>${result.warnings.map((warning) => html`<li>${warning}</li>`)}</ul>
      </section>`
    : "";

const profile = !result?.ok
  ? ""
  : html`<div class="report-region">
      <p class="source-line">Analyzing <strong>${activeReportTab.label}</strong></p>
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

const detail = !result?.ok
  ? ""
  : html`<div class="report-region">
      <details class="events-section methodology-section">
        <summary>
          <span class="methodology-title" role="heading" aria-level="2">How this report is generated</span>
          <span class="methodology-preview">Five stages from the active URL to an evidence-based profile.</span>
        </summary>
        <div class="methodology-content">
          <p class="methodology-intro">
            Tapoo Oracle fetches the active tab's JSON URL and analyzes it entirely in this browser.
            It does not persist the fetched log, infer missing fields, or assign a combined
            intelligence score.
          </p>
          <ol class="analysis-pipeline">
            <li>
              <h3>Fetch the active tab's URL</h3>
              <p>
                Each tab owns one online JSON file URL. Loading that tab fetches the current URL;
                editing the URL clears the previous result so stale analysis is not shown as current
                evidence.
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
        ${diagnosticsTable(result.report)}
      </section>
      <section class="events-section">
        <h2>Provenance</h2>
        <p class="section-note">A profile is only meaningful against the build and round it was measured from.</p>
        ${provenanceTable(result.source, result.report)}
        <p class="source-line">
          The question definitions and answers above come directly from the rubric engine that
          analyzed this log.
        </p>
      </section>
    </div>`;
```

${emptyState}

${notices}

${profile}

${detail}
