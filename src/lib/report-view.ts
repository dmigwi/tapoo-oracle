// The page's view layer.
//
// A module rather than a fenced js block in the markdown, because a fence is neither linted nor testable:
// src/index.md is not in eslint's file list and vitest cannot import one.
//
// Inputs and html arrive as arguments rather than imports. Both are Observable Framework globals in
// markdown, and pulling them in here would mean either an "npm:" specifier that only the framework's
// bundler resolves, or a bare import of htl, which is not a direct dependency. Passing them keeps
// this a plain module that node, vitest and eslint can all read.

import { createMazeReplay } from "./maze-view";
import {
  diagnosticRows,
  diagnosticTableData,
  groupResultTone,
  narrativeSummary,
  profileCards,
  LOG_SCOPE_MARK,
  agentRows,
  provenanceRows,
  validationRows,
  modelOutputRows,
  rubricQuestionRows,
  warningHeadline,
} from "./report-adapters";
import type { AgentRow } from "./report-adapters";
import { CHANGED_JOIN } from "./report-adapters";
import { createInitialLogTabs } from "./log-tabs-view";
import { roundReportFor } from "./rubric-report";
import { gameIdentityKey, roundLabel } from "./rounds";
import { enableRowSelection, prepareRubricTable } from "./rubric-table";
import { relativeAge } from "./utils";
import type { SlicedLogResult, GroupKind, RegionView, Report, LogTab, LogTabsState, GameIdentity, ReportUi, RoundReport, RoundSlice, TapooLog, ValidationCheck } from "./types";


// --- Entry points: what index.md calls ---
//
// All three of the page's calls arrive here, so index.md names one module and the view layer decides
// what else the page reaches. The tabs view itself is built in log-tabs-view.ts - it owns a DOM node
// and its own state, which this module's render functions deliberately do not - and is re-exported
// rather than reimplemented.

export { createLogTabsInput } from "./log-tabs-view";


/** The five regions the page interpolates, one per `${...}` placeholder in the markdown. */
export type ReportRegions = {
  emptyState: RegionView;
  notices: RegionView;
  methodology: RegionView;
  profile: RegionView;
  detail: RegionView;
};

/** renderReportSections is one call per render, returning the regions the page interpolates. Returning an object rather
 * than a single fragment keeps the markdown's ${...} placeholders where they are, so the page's
 * reading order stays visible in the markdown rather than being buried in this file. */
export function renderReportSections(ui: ReportUi, tabsState: LogTabsState | undefined): ReportRegions {
  const tab = activeLogTab(tabsState);

  // Round selection swaps the two regions in place rather than travelling through tab state.
  //
  // Routing it through the Observable input was the obvious design and it does not work: the state
  // updates and the input event fires, but the runtime does not recompute the cell, so the page keeps
  // the round it opened on. Swapping the nodes here is what the maze level select already does on this
  // same page, and it keeps the whole feature inside this module - no page wiring, no new state field,
  // and no chance of a stale round key outliving the log it came from.
  let profileNode: RegionView = "";
  let detailNode: RegionView = "";

  // The round on screen, so a click on the tab already selected can be ignored.
  //
  // Written by profile() and nowhere else, because what a render is *handed* is not always what it
  // draws: a null identity means the first round. Setting this from the identity going in would leave
  // it naming a round that is not on screen, and the next click on the round that *is* would then
  // re-render it - the case the guard exists to prevent.
  //
  // Nothing can reach that divergence today: every identity reaching selectorCallback comes off a tab
  // this render drew, and an identity naming no round now throws rather than quietly drawing another.
  // So this is structure rather than a fix for an observed bug - it keeps the guard correct if a second
  // caller or a keyboard handler ever passes an identity the tabs did not.
  let activeKey: string | null = null;
  const roundKeyCallback = (drawn: GameIdentity): void => { activeKey = gameIdentityKey(drawn) };

  // Named for what it is: a callback the round tabs fire, not part of the render. Nothing below runs
  // until a reader picks a round. It is declared above the first render only because profile() is handed
  // it and it needs profileNode to replace, so the two refer to each other and one has to come first.
  const selectorCallback = (identity: GameIdentity): void => {
    // Only for a round that is not already showing. Re-rendering the round the reader is looking at
    // rebuilds the maze replay from scratch, which sends the scrubber back to the end and turns the
    // magnifier off - so a click meaning "I am already here" silently threw away where they were.
    if (gameIdentityKey(identity) === activeKey) return;

    // The round's caveats live inside the profile region, so they are swapped with it and cannot be
    // left behind naming the round the page opened on.
    const nextProfile = profile(ui, tab, identity, selectorCallback, roundKeyCallback);
    const nextDetail = detail(ui, tab, identity);
    // replaceWith only works on a node with a parent. Guarding rather than asserting keeps a region
    // that was never inserted - a test rendering one half, a caller displaying only the profile - from
    // throwing on the first click.
    if (profileNode instanceof Element && nextProfile instanceof Element && profileNode.parentNode) {
      profileNode.replaceWith(nextProfile);
    }
    if (detailNode instanceof Element && nextDetail instanceof Element && detailNode.parentNode) {
      detailNode.replaceWith(nextDetail);
    }
    profileNode = nextProfile;
    detailNode = nextDetail;
  };

  profileNode = profile(ui, tab, null, selectorCallback, roundKeyCallback);
  detailNode = detail(ui, tab, null);

  return {
    emptyState: emptyState(ui, tab),
    notices: notices(ui, tab),
    methodology: methodology(ui, tab?.result),
    profile: profileNode,
    detail: detailNode,
  };
}

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
      // The ID column is chipped here rather than by styling the cell: one class on one kind of
      // element, so the code on a profile card and the code that defines it are the same object with
      // the same rules. Styling the td instead meant the chip had to fight the cell - shrinking it off
      // the column width and clipping its own background - to look like the spans everywhere else.
      //
      // Unconditional: every value in this column is an identifier by construction.
      id: codeChip(html),
      groupResult: (value: string) => {
        const tone = groupResultTone(kind, value)
        return tone ? html`<span class=${tone}>${value}</span>` : value
      }
    },
    sort: false,
    rows: rows.length
  })));
}

// A rubric identifier - C2, V4, C7.Q1 - gets one reserved appearance wherever it is printed.
//
// These codes are the page's cross-references: a card names C6, the rubric table's ID column defines
// it, and the diagnostics table says which question scores a signal. Set as ordinary text they read as
// part of the sentence around them, and the reader has to notice that "C6" is a thing to look up. One
// treatment, used nowhere else, makes them findable by shape alone.
//
// Which values are identifiers is decided by the caller, never by inspecting the text. A regex over
// cell contents was doing the latter, and it is a guess dressed as a rule: it would chip a group whose
// name happened to look like a code and miss an id the day the scheme gains a letter. Every call site
// below already knows - the ID column holds nothing else, and a diagnostic carries a nullable
// scoredBy.
const codeChip = (html: ReportUi["html"]) => (value: unknown): unknown =>
  html`<span class="rubric-code">${value}</span>`;

function diagnosticsTable({Inputs, html}: ReportUi, report: Report): HTMLElement {
  const data = diagnosticTableData(report);
  // One column per signal, each holding a count in one row and its scoring question in the other. The
  // signal's own scoredBy says which cell is the identifier - an unscored signal has none, so the "-" in
  // its place is never chipped as though it were a code to look up.
  const chip = codeChip(html);
  const format = Object.fromEntries(
    diagnosticRows(report)
      .filter((row) => row.scoredBy !== null)
      .map((row) => [
        row.signal,
        (value: unknown) => (value === row.scoredBy ? chip(value) : value),
      ]),
  );
  return enableRowSelection(Inputs.table(data.rows, {
    columns: data.columns,
    header: {measure: "Measure"},
    format,
    sort: false,
    rows: data.rows.length
  }));
}

// Field and value down the page, not eight columns across it.
//
// One row of eight columns fits a wide screen and trims its own values on anything narrower, each squeezed
// into an eighth of the width - and two of the eight it would hold, a model name and a reasoning effort,
// describe a seat and live in the Agents table instead. Every other summary here is two columns, including
// Model Output directly above, so this reads the same way and the values have the room to be read.
function provenanceTable({Inputs}: ReportUi, source: TapooLog): HTMLElement {
  const rows = provenanceRows(source);
  return enableRowSelection(Inputs.table(rows, {
    columns: ["field", "value"],
    header: {field: "MEASURE", value: "VALUE"},
    sort: false,
    rows: rows.length,
    layout: "auto"
  }));
}

// What each seat was running, one row per seat.
function agentsTable({Inputs, html}: ReportUi, agents: Report["agents"]): HTMLElement {
  const rows = agentRows(agents);
  return enableRowSelection(Inputs.table(rows, {
    columns: ["field", "value"],
    header: {field: "AGENT", value: "RUNNING"},
    format: {value: runningCell(html, rows)},
    sort: false,
    rows: rows.length,
    layout: "auto"
  }));
}

/** runningCell renders one seat's setup with the values weighted above the words joining them.
 *
 * Comparing two seats means comparing three values, and as one flat sentence they sit at the same weight
 * as the words between them - so the three are bold and the joining words go muted. The model is
 * additionally set in mono, being a string copied out of the log, where "Ollama" and "max" are this
 * page's own wording for what the log spelled differently.
 *
 * "on the X API", not "through X". The api field is a wire protocol, and naming it the way a provider is
 * named claimed something it does not say: Hugging Face answers on OpenAI's API, so a seat served there
 * reads "OpenAI" - true of the protocol, false of who ran the model. The endpoint beneath it is what
 * answers that.
 *
 * Deliberately not .rubric-code: that chip means "an identifier defined elsewhere on this page", and
 * nothing defines a model name anywhere else. A second tinted chip would send a reader looking.
 *
 * The endpoint takes its own line rather than the parentheses the plain sentence keeps. It is the widest
 * value on the page and the one this two-column shape exists for; wrapped inline it broke mid-host and
 * pushed the effort onto a line of its own anyway.
 *
 * A setting the seat did not hold still is marked, and its values joined by an arrow in the order the
 * turns ran. Comma-joined and in the same ink as a clean row, two models read as a list - and at a
 * glance as one long name - so the row agentSettingsCheck is reporting looked exactly like the rows it
 * is not. The mark is the page's caveat colour, not a verdict colour: a changed setting is a caveat
 * about what the report can be compared against, not a finding against the agent.
 *
 * Falls back to the sentence if the row is somehow missing, which no caller can currently produce -
 * rows is the array the table was built from. */
const runningCell = (html: ReportUi["html"], rows: AgentRow[]) =>
  (value: string, index: number): unknown => {
    const running = rows[index]?.running;
    if (!running) return value;

    // One setting, as one span: its values joined, and marked when there is more than one of them.
    const setting = (values: string[], extra = ""): unknown =>
      values.length === 0
        ? ""
        : html`<span class=${`agent-value ${extra} ${values.length > 1 ? "agent-changed" : ""}`.trim()}
            >${values.join(CHANGED_JOIN)}</span>`;

    return html`<span
      >${running.models.length === 0
        ? html`<span class="agent-value agent-model">not recorded</span>`
        : setting(running.models, "agent-model")}${
        running.api.length === 0 ? "" : html`<span class="agent-joiner"> on the </span>${setting(running.api)}<span class="agent-joiner"> API</span>`}${
        running.effort.length === 0 ? "" : html`<span class="agent-joiner"> at </span>${setting(running.effort)}<span class="agent-joiner"> reasoning effort</span>`}${
        running.endpoint.length === 0
          ? ""
          : html`<span class=${`agent-endpoint ${running.endpoint.length > 1 ? "agent-changed" : ""}`.trim()}
              >${running.endpoint.join(CHANGED_JOIN)}</span>`}</span>`;
  };

// One scope's worth of checks: what was verified, and what could not be.
function validationTable({Inputs}: ReportUi, checks: ValidationCheck[]): HTMLElement {
  const rows = validationRows(checks);
  return Inputs.table(rows, {
    columns: ["field", "value"],
    header: {field: "CHECK", value: "RESULT"},
    sort: false,
    rows: rows.length,
    layout: "auto"
  });
}

// --- Which report is showing ---

/** activeLogTab is the log tab the rest of the page is about. The state can arrive before the input has
 * produced one, so the shape is normalized rather than assumed - it returns undefined instead of
 * throwing, and every caller renders an empty state from that. */
export function activeLogTab(tabsState: LogTabsState | undefined): LogTab | undefined {
  const state = tabsState?.tabs ? tabsState : createInitialLogTabs();
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
}

// --- Page sections, in reading order ---

function emptyState({html}: ReportUi, tab: LogTab | undefined): RegionView {
  if (tab?.status === "loaded" || tab?.status === "error") return "";
  return html`<section class="notice empty-report-state">
      <strong>Load an online JSON report URL</strong>
      <ol>
        <li>Enter an <code>http://</code> or <code>https://</code> URL.</li>
        <li>Use a Tapoo <code>agent-api</code> JSON log, then select <strong>Load report</strong>.</li>
        <li>Each report owns its URL and analysis; deleting a report removes both.</li>
      </ol>
      <div class="gist-help">
        <strong>Public or non-sensitive payloads only</strong>
        <ol>
          <li>Open <a href="https://gist.github.com">gist.github.com</a> while signed in to GitHub.
            <ul>
              <li>Or skip the browser upload with the <a href="https://cli.github.com">GitHub CLI</a>, which
                creates a secret gist and opens it ready for step 4:
                <pre><code>gh gist create --desc "Tapoo v2.5.1 output payloads from level 54" --web sample-agent-api-log.json</code></pre>
                <code>--desc</code> takes the description as its own argument, so it has to come before
                <code>--web</code>. A secret gist is unlisted, not private; anyone with its URL can read it.</li>
            </ul>
          </li>
          <li>Create a new gist, name the file with a <code>.json</code> extension, and paste or drag in the Tapoo log JSON.</li>
          <li>Do not use Gist for proprietary logs. Use authenticated storage with CORS and short-lived signed URLs instead.</li>
          <li>Open the created gist file's <strong>Raw</strong> view and copy that <code>gist.githubusercontent.com</code> URL.</li>
          <li>Paste the raw URL into <strong>Online JSON file URL</strong>, then select <strong>Load report</strong>.</li>
        </ol>
      </div>
    </section>`;
}

// The export's own caveats, at the top of the page where they bound everything below them: a mode the
// rubric was not written for, a build the report cannot name, entries that did not decode.
//
// A round's caveats are not here; see roundNotices, which renders them beside the round they describe.
// Pooled into this one list, a reader on game 1 is told that game 2's maze failed its checksum - a caveat
// about a report they are not reading - while game 1's own sits in the same list looking equally
// unrelated.
function notices({html}: ReportUi, tab: LogTab | undefined): RegionView {
  const result = tab?.result;
  if (tab?.status === "error") {
    return html`<section class="notice notice-error">
      <strong>Cannot analyze this URL</strong>
      <span>${tab.error}</span>
    </section>`;
  }
  if (!result?.ok || result.warnings.length === 0) return "";

  // The headline states the cost in the reader's own terms before the caveats explain it. A person
  // who reads nothing else should still come away knowing the report below is not to be quoted as-is.
  return html`<section class="notice notice-warn">
      <strong>${warningHeadline(result.warnings)}</strong>
      <ul>${result.warnings.map((warning) => html`<li>${warning.message}</li>`)}</ul>
    </section>`;
}

// One round's caveats, rendered under the round tabs that select it.
//
// Placed here rather than with the export's notices at the top of the page, because a caveat about one
// round only means anything next to the control that chose it. Above the tabs a reader met "Game 3 ·
// Level 2 ..." before knowing there were rounds to choose between, and the label was the only thing
// connecting the two. Under them, the label is confirmation rather than the whole explanation.
function roundNotices({html}: ReportUi, round: RoundReport): RegionView {
  const warnings = round.round.warnings;
  if (warnings.length === 0) return "";

  return html`<section class="notice notice-warn notice-round">
      <strong>${warningHeadline(warnings)}</strong>
      <p class="notice-round-label">${roundLabel(round.identity)}</p>
      <ul>${warnings.map((warning) => html`<li>${warning.message}</li>`)}</ul>
    </section>`;
}

/** activeRound picks the round on screen.
 *
 * A null identity is "nothing selected yet", not one that might match a round - every first render
 * passes it - so it takes the first round without searching for it.
 *
 * Undefined means one thing only: this tab has no report to show a round from. A parsed log always has
 * at least one round - SlicedLog.rounds says so in its type - so "loaded but roundless" is not a state
 * a caller has to render around.
 *
 * Throws on an identity naming no round, because that is a programming error rather than anything a
 * reader did: every identity reaching here came off a round tab this module drew, so a miss means the
 * tabs and the analysis have gone out of step. Falling back to the first round hides that - the report
 * renders, the first tab highlights, and nothing says another round was asked for. The same reasoning as
 * stepFrom, which throws on a key it did not build. */
export function activeRound(tab: LogTab | undefined, wanted: GameIdentity | null): RoundReport | undefined {
  const result = tab?.result;
  if (!result?.ok) return undefined;
  const rounds = result.rounds;
  const slice =
    wanted === null
      ? rounds[0]
      : rounds.find((round) => gameIdentityKey(round.identity) === gameIdentityKey(wanted));
  if (slice === undefined) {
    throw new Error(`no round ${gameIdentityKey(wanted as GameIdentity)} in this report`);
  }
  // Answered here, not when the log was opened. Every consumer of a round comes through this function,
  // so this is the one place that has to know the rubric pass is deferred - and roundReportFor
  // memoizes, so asking twice in one render costs one pass.
  return roundReportFor(slice);
}

// The round tabs, directly under the source line: which game and level the verdicts below belong to,
// and how to read another one.
//
// Rendered only when there is a choice to make. One round needs no tablist - its identity is stated on
// the line above instead, where it costs no vertical space and still names the game analyzed.
function roundTabs(
  {html}: ReportUi,
  rounds: RoundSlice[],
  active: RoundSlice,
  selectorCallback: (identity: GameIdentity) => void,
): RegionView {
  if (rounds.length < 2) return "";

  const activeKey = gameIdentityKey(active.identity);
  return html`<div class="round-tabs" role="tablist" aria-label="Game to analyze">
      ${rounds.map((round) => {
        const selected = gameIdentityKey(round.identity) === activeKey;
        return html`<button
          type="button"
          role="tab"
          class=${`round-tab${selected ? " round-tab-active" : ""}`}
          aria-selected=${String(selected)}
          onclick=${() => selectorCallback(round.identity)}
        >${roundLabel(round.identity)}</button>`;
      })}
    </div>`;
}

function profile(
  ui: ReportUi,
  tab: LogTab | undefined,
  wanted: GameIdentity | null,
  selectorCallback: (identity: GameIdentity) => void,
  roundKeyCallback: (drawn: GameIdentity) => void = () => {},
): RegionView {
  const {html} = ui;
  const result = tab?.result;
  // Nothing loaded yet, or a tab that failed: emptyState and notices carry those, and this renders
  // nothing. There is deliberately no third arm for "loaded but no round" - result.ok now guarantees a
  // round, so a blank profile can only ever mean a blank tab.
  const round = activeRound(tab, wanted);
  if (!tab || !result?.ok || round === undefined) return "";
  // Which round this actually drew, which is not always what it was handed: a null identity means the
  // first round. The caller needs the resolved answer, and asking activeRound for it a second time
  // would be a second place applying the same rule.
  roundKeyCallback(round.identity);
  const rounds = result.rounds;
  return html`<div class="report-region">
      <section class="events-section">
        <p class="source-line">Analyzing <strong>${tab.label}</strong></p>
        ${rounds.length < 2
          ? html`<p class="round-identity">${roundLabel(round.identity)}</p>`
          : roundTabs(ui, rounds, round, selectorCallback)}
        ${roundNotices(ui, round)}
        <p class="processing-note">
          Log contents are analyzed in your browser and never uploaded; a shared link carries the log
          address to the host serving this page.
        </p>
        ${createMazeReplay(round.report.level)}
      </section>
      <section class="events-section oracle-summary">
        <h2>Behavior Profile</h2>
        <p>${narrativeSummary(round.report)}</p>
        <span class="analysis-strip">
        ${profileCards(round.report).map(
          (card) => html`<article class=${`metric metric-${card.tone}`}>
            <span>${card.label}</span>
            <strong>${card.value}</strong>
            ${card.groups.length > 0
              ? html`<span class="metric-detail">${card.groups.map(
                    (group) =>
                      html`<span class="metric-group"><span class="rubric-code">${group.id}</span> ${group.label}</span>`,
                  )}</span>`
              : ""}
          </article>`
        )}
        </span>
      </section>
    </div>`;
}

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
//
// It is also the one home for how the report is made: that no combined score is produced, that every
// question answers YES or NO, and what a NO means. A rule stated in three places - here, the hero lede,
// the profile summary - reads as three separate hedges rather than one method, so the lede and the summary
// say what they are for and leave the method to the section named after it.
function methodology({html}: ReportUi, result: SlicedLogResult | undefined): RegionView {
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

// detail is the evidence itself: the rubric tables, the diagnostics, and the provenance of the log
// they were read from.
function detail(ui: ReportUi, tab: LogTab | undefined, wanted: GameIdentity | null): RegionView {
  const result = tab?.result;
  const round = activeRound(tab, wanted);
  if (!result?.ok || round === undefined) return "";
  const {html} = ui;
  const report = round.report;
  return html`<div class="report-region">
      <section class="events-section">
        <h2>Capabilities</h2>
        <p class="section-note">AND semantics: every fact question must answer YES for its group to be demonstrated.</p>
        <div class="rubric-table">${rubricTable(ui, rubricQuestionRows(report.capabilities), "capability")}</div>
      </section>
      <section class="events-section">
        <h2>Violations</h2>
        <p class="section-note">OR semantics: any fact question answering YES confirms its violation group.</p>
        <div class="rubric-table">${rubricTable(ui, rubricQuestionRows(report.violations), "violation")}</div>
      </section>
      <section class="events-section">
        <h2>Operational Diagnostics</h2>
        <p class="section-note">Failed requests and harness faults are excluded from the violation profile: a provider outage and a fault in Tapoo's own tooling are not the model's reasoning. The columns with a rubric code beneath them are the ones a question scores.</p>
        ${diagnosticsTable(ui, report)}
      </section>
      <section class="events-section">
        <h2>Model Output</h2>
        <p class="section-note">What the provider reported about the model's own work. Not scored: a model given ten times the prompt and a model that spent its budget reasoning are doing different tasks, and that is context for the verdicts above rather than a verdict itself.</p>
        ${ui.Inputs.table(modelOutputRows(report), {
          columns: ["field", "value"],
          header: {field: "MEASURE", value: "VALUE"},
          sort: false,
          rows: modelOutputRows(report).length,
          layout: "auto"
        })}
      </section>
      <section class="events-section">
        <h2>Provenance</h2>
        <p class="section-note">A profile is only meaningful against the build and round it was measured from.</p>
        ${provenanceTable(ui, result.source)}
      </section>
      <section class="events-section">
        <h2>Agents</h2>
        <p class="section-note">
          One row per seat that played this round. A turn is played by exactly one agent, so what it was
          running belongs to the seat rather than to the report - a round seating two agents on two
          models has no single answer to give.
        </p>
        ${agentsTable(ui, report.agents)}
      </section>
      <section class="events-section">
        <h2>Payload validation</h2>
        <p class="section-note">
          What was checked before any of the above was answered, and what could not be. A check that
          found nothing wrong and a check that never ran both used to look the same: this report says
          nothing when every payload is intact, so "not checked" is the line worth reading.
        </p>
        ${validationTable(ui, [...result.checks, ...round.round.checks])}
        <p class="source-line">
          ${LOG_SCOPE_MARK} Checked once over the whole log file, so it holds for every round in it, not
          only the one on screen.
        </p>
        <p class="source-line">
          The question definitions and answers above come directly from the rubric engine that
          analyzed this log.
        </p>
      </section>
    </div>`;
}

// --- The build stamp ---

/** The element observablehq.config.js writes, found by attribute rather than by position in the footer. */
const STAMP = "time[data-build-age]";

/** Appends "(3 days ago)" to the build stamp, if the page has one.
 *
 * The date itself is stamped at build time by observablehq.config.js, because that is the only moment
 * that knows it. How long ago that was can only be answered when someone is looking, so the config
 * writes a <time> element carrying the machine-readable instant and this fills in the human part.
 *
 * Split that way on purpose: a build-time string saying "0 seconds ago" would be a lie on every visit
 * after the first, and a fully client-rendered date would leave the footer blank for a reader with
 * scripting off. What ships in the HTML is already true and already useful; this only sharpens it.
 *
 * `now` is a parameter rather than read inside, so the age can be tested at a fixed instant instead of
 * whenever the suite happens to run.
 *
 * Silent when the stamp is missing or its datetime does not parse: this is a footer decoration, and a
 * page that renders everything else correctly must not fail over it.
 */
export function stampBuildAge(root: ParentNode, now: Date): void {
  const stamp = root.querySelector(STAMP);
  const iso = stamp?.getAttribute("datetime");
  if (!stamp || !iso) return;

  const built = new Date(iso);
  if (Number.isNaN(built.getTime())) return;

  // Replaced rather than appended, so a second call - a re-render, a hot reload - does not stack a
  // second parenthetical onto the first.
  const age = stamp.parentElement?.querySelector(".build-age") ?? null;
  const node = age ?? document.createElement("span");
  node.className = "build-age";
  node.textContent = ` (${relativeAge(built, now)})`;
  if (!age) stamp.after(node);
}
