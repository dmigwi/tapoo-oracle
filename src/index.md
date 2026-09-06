---
title: Tapoo Oracle
toc: false
---

```js
import {createReportTabsInput, renderReportSections, stampBuildAge} from "./app.js";
```

<section class="oracle-hero">
  <div>
    <h1>Tapoo Oracle</h1>
    <p class="lede">Load an online <a href="https://dmigwi.github.io/tapoo/">Tapoo</a> <code>agent-api</code> JSON log URL and read the agent's behavior profile, built only from what the log records. How that is done is set out under <em>How this report is generated</em>, beside the report itself.</p>
  </div>
</section>

```js
const reportTabsState = view(createReportTabsInput());
```

```js
// The footer's build date is stamped into the HTML; how long ago that was can only be answered while
// someone is looking, so it is finished here.
stampBuildAge(document, new Date());
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
