---
title: Tapoo Oracle
toc: false
---

```js
import {createReportTabsInput, renderReportSections} from "./app.js";
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
// imported by it: that keeps src/lib/report-view.ts a plain module the linter and vitest can
// both read. Everything the page renders below is built there.
const report = renderReportSections({Inputs, html}, reportTabsState);
```

${report.emptyState}

${report.notices}

${report.methodology}

${report.profile}

${report.detail}
