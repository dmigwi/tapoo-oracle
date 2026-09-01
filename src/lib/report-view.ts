// The page's view layer, lifted out of src/index.md.
//
// Everything here used to live in a fenced js block in the markdown, where it was neither linted nor
// testable: src/index.md is not in eslint's file list and vitest cannot import a markdown fence.
//
// Inputs and html arrive as arguments rather than imports. Both are Observable Framework globals in
// markdown, and pulling them in here would mean either an "npm:" specifier that only the framework's
// bundler resolves, or a bare import of htl, which is not a direct dependency. Passing them keeps
// this a plain module that node, vitest and eslint can all read.

import { createMazeReplay } from "./maze-view";
import {
  diagnosticTableData,
  groupResultTone,
  narrativeSummary,
  profileCards,
  provenanceTableData,
  modelOutputRows,
  rubricQuestionRows,
  warningHeadline,
} from "./report-adapters";
import { createInitialReportTabs } from "./report-tabs";
import { enableRowSelection, prepareRubricTable } from "./rubric-table";
import type { Analysis, GroupKind, Region, ReportTab, ReportTabsState, ReportUi, TapooLog } from "./types";


// --- Shared tables ---

// Every conditional section is built here rather than in a markdown ${...} wrapper. Observable
// evaluates a block-level expression only when it is a single line: a multi-line ternary around an
// html`` template leaks its source onto the page as literal text while still rendering the HTML
// inside it, which looks close enough to correct to survive review.
// No fixed pixel widths: they added to 1060px, so the report's own content scrolled sideways on any
// laptop narrower than that. Proportions live in oracle.css instead, which lets the question column
// take the space it needs at any width.
//
// Selection stays on. Nothing downstream reads it, but that is not what it is for: these are 15 and
// 9 row tables of near-identical sentences, and the checkbox is how a reader keeps their place or
// marks the rows they are comparing. oracle.css tints the checked row.
// kind is what makes the colour readable: YES means opposite things in the two tables. A capability
// group answering YES was demonstrated, which is sage; a violation group answering YES was confirmed,
// which is rose. Only the YES rows are coloured - a capability answering NO means the behavior was
// not observed in this sample, never that the model cannot do it, and painting that red would state
// the one thing this report exists to avoid saying.
function rubricTable({Inputs, html}: ReportUi, rows: Array<Record<string, string>>, kind: GroupKind): Element {
  return prepareRubricTable(enableRowSelection(Inputs.table(rows, {
    columns: ["id", "group", "question", "answer", "groupResult"],
    header: {id: "ID", group: "Group", question: "Fact question", answer: "Answer", groupResult: "Group result"},
    format: {
      groupResult: (value: string) => {
        const tone = groupResultTone(kind, value)
        return tone ? html`<span class=${tone}>${value}</span>` : value
      }
    },
    sort: false,
    rows: rows.length
  })));
}

function diagnosticsTable({Inputs}: ReportUi, report: NonNullable<Analysis & {ok: true}>["report"]): HTMLElement {
  const data = diagnosticTableData(report);
  return enableRowSelection(Inputs.table(data.rows, {
    columns: data.columns,
    header: {measure: "Measure"},
    sort: false,
    rows: data.rows.length
  }));
}

function provenanceTable({Inputs}: ReportUi, source: TapooLog, report: NonNullable<Analysis & {ok: true}>["report"]): HTMLElement {
  const data = provenanceTableData(source, report);
  return enableRowSelection(Inputs.table(data.rows, {
    columns: data.columns,
    sort: false,
    rows: data.rows.length
  }));
}

// --- Which report is showing ---

// The tab the rest of the page is about. The state can arrive before the input has produced one, so
// the shape is normalized rather than assumed.
export function activeReportTab(tabsState: ReportTabsState | undefined): ReportTab | undefined {
  const state = tabsState?.tabs ? tabsState : createInitialReportTabs();
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
}

// --- Page sections, in reading order ---

function emptyState({html}: ReportUi, tab: ReportTab | undefined): Region {
  if (tab?.status === "loaded" || tab?.status === "error") return "";
  return html`<section class="notice empty-report-state">
      <strong>Load an online JSON report URL</strong>
      <ol>
        <li>Enter an <code>http://</code> or <code>https://</code> URL.</li>
        <li>Use a Tapoo <code>agent-api</code> JSON log, then select <strong>Load report</strong>.</li>
        <li>Each report owns its URL and analysis; deleting a report removes both.</li>
      </ol>
      <div class="gist-help">
        <strong>Host a local JSON payload with GitHub Gist</strong>
        <ol>
          <li>Open <a href="https://gist.github.com">gist.github.com</a> while signed in to GitHub.
            <ul>
              <li>Or skip the browser upload with the <a href="https://cli.github.com">GitHub CLI</a>, which
                creates the gist and opens it ready for step 4:
                <pre><code>gh gist create --desc "Tapoo v2.5.1 output payloads from level 54" --web sample-agent-api-log.json</code></pre>
                <code>--desc</code> takes the description as its own argument, so it has to come before
                <code>--web</code>. <code>gh</code> creates secret gists by default, which is the safer of the two
                choices in step 3; add <code>--public</code> only when the payload is safe to publish.</li>
            </ul>
          </li>
          <li>Create a new gist, name the file with a <code>.json</code> extension, and paste or drag in the Tapoo log JSON.</li>
          <li>Create a secret gist for a share-by-link report, or a public gist only when the payload is safe to publish.</li>
          <li>Open the created gist file's <strong>Raw</strong> view and copy that <code>gist.githubusercontent.com</code> URL.</li>
          <li>Paste the raw URL into <strong>Online JSON file URL</strong>, then select <strong>Load report</strong>.</li>
        </ol>
      </div>
    </section>`;
}

function notices({html}: ReportUi, tab: ReportTab | undefined): Region {
  const result = tab?.result;
  if (tab?.status === "error") {
    return html`<section class="notice notice-error">
      <strong>Cannot analyze this URL</strong>
      <span>${tab.error}</span>
    </section>`;
  }
  if (result?.ok && result.warnings.length > 0) {
    // The headline states the cost in the reader's own terms before the caveats explain it. A person
    // who reads nothing else should still come away knowing the report below is not to be quoted as-is.
    return html`<section class="notice notice-warn">
        <strong>${warningHeadline(result.warnings)}</strong>
        <ul>${result.warnings.map((warning) => html`<li>${warning.message}</li>`)}</ul>
      </section>`;
  }
  return "";
}

function profile({html}: ReportUi, tab: ReportTab | undefined): Region {
  const result = tab?.result;
  if (!tab || !result?.ok) return "";
  return html`<div class="report-region">
      <section class="events-section">
        <p class="source-line">Analyzing <strong>${tab.label}</strong></p>
        ${createMazeReplay(result.report)}
      </section>
      <section class="analysis-strip">
        ${profileCards(result.report).map(
          (card) => html`<article class=${`metric metric-${card.tone}`}>
            <span>${card.label}</span>
            <strong>${card.value}</strong>
          </article>`
        )}
      </section>
      <section class="events-section oracle-summary">
        <h2>Behavior Profile</h2>
        <p>${narrativeSummary(result.report)}</p>
      </section>
    </div>`;
}

// detail is the evidence itself: the rubric tables, the diagnostics, and the provenance of the log
// they were read from.
// How this report is generated.
//
// Reference material, so it is collapsed, and it sits directly under the share panel because a reader
// deciding whether to trust a profile - or whether to pass its link on - asks how it was made before
// they read its verdicts.
//
// It was static markup in index.md for a while, on the grounds that it interpolates nothing. That was
// true and still wrong: a page with no report loaded showed five stages of methodology above an empty
// state telling the reader to paste a URL, explaining the treatment of evidence that does not exist
// yet. It renders here so it appears with the thing it describes.
function methodology({html}: ReportUi, result: Analysis | undefined): Region {
  if (!result?.ok) return "";
  return html`<details class="events-section methodology-section">
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
    </details>`;
}

function detail(ui: ReportUi, result: Analysis | undefined): Region {
  if (!result?.ok) return "";
  const {html} = ui;
  return html`<div class="report-region">
      <section class="events-section">
        <h2>Capabilities</h2>
        <p class="section-note">AND semantics: every fact question must answer YES for its group to be demonstrated.</p>
        <div class="rubric-table">${rubricTable(ui, rubricQuestionRows(result.report.capabilities), "capability")}</div>
      </section>
      <section class="events-section">
        <h2>Violations</h2>
        <p class="section-note">OR semantics: any fact question answering YES confirms its violation group.</p>
        <div class="rubric-table">${rubricTable(ui, rubricQuestionRows(result.report.violations), "violation")}</div>
      </section>
      <section class="events-section">
        <h2>Operational Diagnostics</h2>
        <p class="section-note">Endpoint failures are excluded from the violation profile: they can be caused by infrastructure outside the model's reasoning behavior.</p>
        ${diagnosticsTable(ui, result.report)}
      </section>
      <section class="events-section">
        <h2>Model Output</h2>
        <p class="section-note">What the provider reported about the model's own work. Not scored: a model given ten times the prompt and a model that spent its budget reasoning are doing different tasks, and that is context for the verdicts above rather than a verdict itself.</p>
        ${ui.Inputs.table(modelOutputRows(result.report), {
          columns: ["field", "value"],
          header: {field: "MEASURE", value: "VALUE"},
          sort: false,
          rows: modelOutputRows(result.report).length,
          layout: "auto"
        })}
      </section>
      <section class="events-section">
        <h2>Provenance</h2>
        <p class="section-note">A profile is only meaningful against the build and round it was measured from.</p>
        ${provenanceTable(ui, result.source, result.report)}
        <p class="source-line">
          The question definitions and answers above come directly from the rubric engine that
          analyzed this log.
        </p>
      </section>
    </div>`;
}

// --- Entry point ---

// One call per render, returning the four regions the page interpolates. Returning an object rather
// than a single fragment keeps the markdown's ${...} placeholders where they are, so the page's
// reading order stays visible in the markdown rather than being buried in this file.
export function renderReportSections(
  ui: ReportUi,
  tabsState: ReportTabsState | undefined,
): {emptyState: Region; notices: Region; methodology: Region; profile: Region; detail: Region} {
  const tab = activeReportTab(tabsState);
  return {
    emptyState: emptyState(ui, tab),
    notices: notices(ui, tab),
    methodology: methodology(ui, tab?.result),
    profile: profile(ui, tab),
    detail: detail(ui, tab?.result)
  };
}
