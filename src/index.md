---
title: Tapoo Oracle
toc: false
---

```js
import {createReportTabsInput} from "./components/oracle.js";
import {renderReportSections} from "./components/report-view.js";
```

<section class="oracle-hero">
  <div>
    <h1>Tapoo Oracle</h1>
    <p class="lede">Load an online <a href="https://dmigwi.github.io/tapoo/">Tapoo</a> <code>agent-api</code> JSON log URL and read the agent's behavior profile: nine capability groups and six violation groups, answered strictly YES or NO from logged evidence. Not a scorecard &mdash; no combined intelligence score is produced.</p>
  </div>
</section>

```js
const reportTabsState = view(createReportTabsInput());
```

```js
// Inputs and html are Observable globals, so they are handed to the view module rather than
// imported by it: that keeps src/components/report-view.js a plain module the linter and vitest can
// both read. Everything the page renders below is built there.
const report = renderReportSections({Inputs, html}, reportTabsState);
```

<!-- Static, so it lives in the page rather than in a js template: it has no interpolation and no
     dependency on a loaded report. It sits directly under the share panel because a reader deciding
     whether to trust a profile - or whether to pass its link on - asks how it was made before they
     read its verdicts. Collapsed, since it is reference material. -->
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

${report.emptyState}

${report.notices}

${report.profile}

${report.detail}
