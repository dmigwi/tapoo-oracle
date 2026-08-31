// Adapter between the rubric engine and this app's views.
//
// The analysis itself is not implemented here. It lives in src/analysis, which this app
// and the terminal front end (`make agentic-analysis`) both call, so the two cannot answer the same
// question about the same log differently. Everything below is presentation: turning one engine
// result into rows, cards, and sentences.
//
// The rule this file follows is that nothing it displays may be invented. Every number traces to a
// rubric answer or to an explicitly logged event - no substring sniffing, no guessed field names, no
// signal that the contract does not define. A plausible-looking number with no basis in the log is
// worse than an absent one, because it still reads as evidence.

import { parseTapooLogExport } from "../analysis/log-contract.js";
import { answerRubric } from "../analysis/rubric-engine.js";

// analyzeLogText is the single entry point from raw text to a rendered result. It returns a
// discriminated result instead of throwing, because every failure here is a person's input mistake
// that the page has to explain, not an exceptional condition.
export function analyzeLogText(text, {label = "online log", sourceUrl} = {}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return {ok: false, error: "Load a Tapoo agent-api log from an online JSON URL to begin."};
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
    source: sourceUrl ? {...result.value, sourceUrl} : result.value,
    warnings: result.warnings,
    report: answerRubric(result.value.entries, {label})
  };
}

export function createEmptyReportTab(id = reportTabId()) {
  return {
    id,
    url: "",
    label: "New report",
    status: "empty",
  };
}

export function createInitialReportTabs() {
  return {
    tabs: [],
    activeTabId: null,
    isAdding: true,
    draftUrl: "",
    draftStatus: "empty",
  };
}

export function validateOnlineJsonUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return {ok: false, error: "Enter an online JSON file URL."};
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return {ok: false, error: "Enter a valid URL."};
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return {ok: false, error: "Use an online http:// or https:// JSON URL."};
  }

  return {ok: true, url: url.href};
}

export function reportTabLabelFromUrl(value, index = 0) {
  const fallback = `Report ${index + 1}`;
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
    return trimReportTabLabel(name || url.hostname || fallback);
  } catch {
    return fallback;
  }
}

export function trimReportTabLabel(value, maxLength = 34) {
  const label = String(value ?? "").trim();
  if (label.length <= maxLength) return label;
  return `...${label.slice(-(maxLength - 3))}`;
}

export function addReportTab(state, id = reportTabId()) {
  return {
    ...state,
    pendingTabId: id,
    isAdding: true,
    draftUrl: "",
    draftStatus: "empty",
    draftError: undefined,
  };
}

export function updateReportTab(state, tabId, patch) {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? {...tab, ...patch} : tab)),
  };
}

export function deleteReportTab(state, tabId, createId = reportTabId) {
  const deletedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) {
    return {
      ...createInitialReportTabs(),
      pendingTabId: createId(),
    };
  }

  if (state.activeTabId !== tabId) {
    return {...state, tabs};
  }

  const nextIndex = Math.min(Math.max(deletedIndex, 0), tabs.length - 1);
  return {tabs, activeTabId: tabs[nextIndex].id};
}

export async function loadNewReportTabFromUrl(state, fetchText = fetchReportText) {
  const tabId = state.pendingTabId ?? reportTabId();
  const validation = validateOnlineJsonUrl(state.draftUrl);
  if (!validation.ok) {
    return {
      ...state,
      isAdding: true,
      draftStatus: "error",
      draftError: validation.error,
    };
  }

  const label = reportTabLabelFromUrl(validation.url, state.tabs.length);
  const baseTab = {
    id: tabId,
    url: validation.url,
    label,
    loadedUrl: validation.url,
  };

  try {
    const text = await fetchText(validation.url);
    const result = analyzeLogText(text, {label, sourceUrl: validation.url});
    const tab = result.ok
      ? {...baseTab, status: "loaded", result, error: undefined}
      : {...baseTab, status: "error", result, error: result.error};
    return {
      ...state,
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      isAdding: false,
      draftUrl: "",
      draftStatus: "empty",
      draftError: undefined,
      pendingTabId: undefined,
    };
  } catch (error) {
    const tab = {
      ...baseTab,
      status: "error",
      error: `Could not load URL: ${error.message}`,
      result: undefined,
    };
    return {
      ...state,
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      isAdding: false,
      draftUrl: "",
      draftStatus: "empty",
      draftError: undefined,
      pendingTabId: undefined,
    };
  }
}

export async function loadReportTabFromUrl(state, tabId, fetchText = fetchReportText) {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  const validation = validateOnlineJsonUrl(tab?.url);
  if (!validation.ok) {
    return updateReportTab(state, tabId, {
      status: "error",
      error: validation.error,
      result: undefined,
      loadedUrl: undefined,
    });
  }

  const label = reportTabLabelFromUrl(validation.url, state.tabs.findIndex((candidate) => candidate.id === tabId));
  try {
    const text = await fetchText(validation.url);
    const result = analyzeLogText(text, {label, sourceUrl: validation.url});
    return updateReportTab(state, tabId, result.ok
      ? {status: "loaded", label, result, loadedUrl: validation.url, error: undefined}
      : {status: "error", label, result, loadedUrl: validation.url, error: result.error});
  } catch (error) {
    return updateReportTab(state, tabId, {
      status: "error",
      label,
      error: `Could not load URL: ${error.message}`,
      result: undefined,
      loadedUrl: validation.url,
    });
  }
}

export function createReportTabsInput({fetchText = fetchReportText} = {}) {
  let state = createInitialReportTabs();
  const root = document.createElement("section");
  root.className = "report-workspace";
  Object.defineProperty(root, "value", {
    get: () => state,
  });

  const emit = () => {
    root.dispatchEvent(new Event("input", {bubbles: true}));
    render();
  };

  const setState = (nextState) => {
    state = nextState;
    emit();
  };

  const loadNewTab = async () => {
    const requestedUrl = state.draftUrl;
    setState({...state, draftStatus: "loading", draftError: undefined});
    const loadedState = await loadNewReportTabFromUrl(state, fetchText);
    if (state.draftUrl !== requestedUrl) return;
    setState(loadedState);
  };

  const render = () => {
    root.replaceChildren();
    const navigator = document.createElement("section");
    navigator.className = "report-navigator";
    navigator.setAttribute("aria-label", "Loaded reports");

    const add = document.createElement("button");
    add.type = "button";
    add.className = "report-add";
    add.textContent = "+ Add Report";
    add.addEventListener("click", () => setState(addReportTab(state)));
    navigator.append(add);

    const nav = document.createElement("div");
    nav.className = "report-list";
    nav.setAttribute("role", "tablist");

    for (const tab of state.tabs) {
      const item = document.createElement("div");
      item.className = `report-list-item${tab.id === state.activeTabId ? " report-list-item-active" : ""}`;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "report-list-button";
      button.textContent = tab.label;
      button.title = tab.loadedUrl ?? tab.url ?? tab.label;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(tab.id === state.activeTabId));
      button.addEventListener("click", () => setState({...state, activeTabId: tab.id, isAdding: false}));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "report-delete";
      remove.setAttribute("aria-label", `Delete ${tab.label}`);
      remove.textContent = "x";
      remove.addEventListener("click", () => setState(deleteReportTab(state, tab.id)));

      item.append(button, remove);
      nav.append(item);
    }

    navigator.append(nav);

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
    const content = document.createElement("section");
    content.className = "report-active-panel";
    if (!state.isAdding && activeTab) {
      const source = document.createElement("p");
      source.className = "report-source-url";
      source.textContent = activeTab.loadedUrl ?? activeTab.url;
      content.append(source);
      root.append(navigator, content);
      return;
    }

    if (!state.isAdding) {
      root.append(navigator, content);
      return;
    }

    const form = document.createElement("form");
    form.className = "report-url-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void loadNewTab();
    });

    const label = document.createElement("label");
    label.textContent = "Online JSON file URL";
    label.htmlFor = `${state.pendingTabId ?? "new-report"}-url`;

    const input = document.createElement("input");
    input.id = `${state.pendingTabId ?? "new-report"}-url`;
    input.type = "url";
    input.placeholder = "https://example.com/tapoo-agent-api-log.json";
    input.value = state.draftUrl;
    input.addEventListener("input", () => {
      state = {...state, draftUrl: input.value, draftStatus: "empty", draftError: undefined};
      root.dispatchEvent(new Event("input", {bubbles: true}));
    });

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = state.draftStatus === "loading" ? "Loading..." : "Load report";
    submit.disabled = state.draftStatus === "loading";

    form.append(label, input, submit);
    if (state.draftStatus === "error") {
      const error = document.createElement("p");
      error.className = "report-url-error";
      error.textContent = state.draftError;
      form.append(error);
    }
    content.append(form);
    root.append(navigator, content);
  };

  render();
  return root;
}

// profileCards summarizes a report as headline counts.
//
// Capabilities and violations are reported as separate fractions and never combined. The rubric is
// explicit that they must not collapse into one score interval: a model with six capabilities and
// two violations is not "four", and any arithmetic that produces a single number here would be
// inventing a scale the contract deliberately refuses to define.
// groupResultTone names the class a group result should carry, or null for no colour at all.
//
// Split out from the table's format callback because this is the part that can be wrong: YES means
// opposite things in the two tables, and the rule for what stays uncoloured is a statement about
// what the rubric claims. The span-wrapping around it cannot be, so the DOM stays in the view and
// the decision stays here where the suite can reach it.
export function groupResultTone(kind, groupResult) {
  // NO is never coloured. For a violation it is the good outcome, and for a capability it means the
  // behavior was not observed in this sample - never that the model is incapable of it, which is the
  // one thing this report exists not to say. Red on that line would say it.
  if (!String(groupResult).startsWith("YES")) {
    return null
  }

  return kind === "violation" ? "result-confirmed" : "result-demonstrated"
}

// enableRowSelection makes the whole row a click target for its own checkbox. The checkbox is a
// 13px square at the far left of a row whose content runs the width of the page, so hitting it means
// aiming at the one part of the row that is hardest to hit - and on a touch screen it is below the
// recommended target size outright.
//
// Delegated on the table rather than bound per row, so it survives Inputs.table re-rendering its
// body, and it dispatches input *and* change: Inputs.table reads its value from input events, and
// the CSS that tints the row keys off :checked, so a silent .checked assignment would move the tint
// without moving the input's value.
export function enableRowSelection(node) {
  const table = node.querySelector("table")
  if (!table) {
    return node
  }

  table.addEventListener("click", (event) => {
    // The control itself already toggles; handling it here as well would toggle twice and land back
    // where it started. Links and buttons inside a cell keep their own behavior.
    if (event.target.closest("input, a, button, label")) {
      return
    }

    // A click that ends a text selection is someone copying a fact question, not choosing a row.
    if (window.getSelection()?.toString()) {
      return
    }

    const checkbox = event.target.closest("tbody tr")?.querySelector("input[type=checkbox]")
    if (!checkbox) {
      return
    }

    // Forward the click to the checkbox rather than setting .checked and announcing it. Inputs.table
    // wires every row checkbox with `input.onclick = reselect`, and that handler owns the selection
    // set, the header checkbox's checked/indeterminate state, and the table's own value. Assigning
    // .checked moves the tick and the :checked tint while none of that bookkeeping runs - the row
    // looks selected, the header stays blank, and the value the table reports omits the row. A click
    // dispatched on a checkbox performs its activation behavior, so the toggle is still native.
    //
    // shiftKey and detail are carried over so a shift-click on a row extends the range exactly as a
    // shift-click on the checkbox does, and so reselect's blur-on-real-click still fires.
    checkbox.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      shiftKey: event.shiftKey,
      detail: event.detail,
    }))
  })

  return node
}

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

// rubricQuestionRows gives every evaluated fact its own row. Group verdicts and fractions remain
// visible because a partially evidenced group and a group with no evidence can share the same NO.
export function rubricQuestionRows(groups) {
  return groups.flatMap((group) =>
    Object.entries(group.answers).map(([questionId, answer]) => ({
      id: `${group.id}.${questionId}`,
      group: group.label,
      question: group.questions[questionId],
      answer: answer ? "YES" : "NO",
      groupResult: `${group.met ? "YES" : "NO"} (${group.passed}/${group.total})`,
    })),
  )
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

// diagnosticTableData pivots the short diagnostic list into a wide comparison matrix. Keeping the
// two measures as rows avoids packing count and scoring semantics into an ambiguous combined value.
export function diagnosticTableData(report) {
  const diagnostics = diagnosticRows(report)
  const columns = ["measure", ...diagnostics.map((row) => row.signal)]

  return {
    columns,
    rows: [
      Object.fromEntries([["measure", "Count"], ...diagnostics.map((row) => [row.signal, row.count])]),
      Object.fromEntries([["measure", "Scored as"], ...diagnostics.map((row) => [row.signal, row.scored])]),
    ],
  }
}

// provenanceRows describe which build and which round produced the log, so a profile is never read
// detached from what it was measured against.
export function provenanceRows(source, report) {
  return [
    {field: "Source URL", value: source.sourceUrl ?? "not recorded"},
    {field: "Tapoo version", value: source.version ?? "not recorded"},
    {field: "Control mode", value: source.mode ?? "not recorded"},
    {field: "Downloaded at", value: source.downloadedAt ?? "not recorded"},
    {field: "Log entries", value: formatCount(source.entries.length)},
    {field: "Model", value: report.model ?? "not recorded"},
    {field: "Player", value: report.player ?? "not recorded"}
  ];
}

// provenanceTableData renders the small provenance record as one horizontal row so a wide report
// does not spend six rows on six short values.
export function provenanceTableData(source, report) {
  const provenance = provenanceRows(source, report)
  return {
    columns: provenance.map((row) => row.field),
    rows: [Object.fromEntries(provenance.map((row) => [row.field, row.value]))],
  }
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

async function fetchReportText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || "HTTP error"}`);
  }
  return response.text();
}

function reportTabId() {
  if (globalThis.crypto?.randomUUID) {
    return `report-${globalThis.crypto.randomUUID()}`;
  }
  return `report-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
