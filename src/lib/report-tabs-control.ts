// The report tabs control: the one Observable view the page binds to.
//
// Built imperatively because it owns its own state and repaints in place. Everything it decides is
// delegated to the pure reducers in report-tabs.ts, so the logic stays testable without a document.

import {
  addReportTab,
  createInitialReportTabs,
  deleteReportTab,
  loadNewReportTabFromUrl,
  } from "./report-tabs"
import {
  appRootFor,
  decodeReportPayload,
  reportPayloadFromHash,
  reportPayloadFromPath,
  shareLinkFor,
} from "./share-link"
import type { ReportTab, ReportTabsInput, ReportTabsState } from "./types"

/** What the rendered controls may ask the workspace to do.
 *
 * The render helpers are handed this rather than the state setter alone, because several of them
 * dispatch a state change derived from the state at click time, not at render time. */
type ReportActions = {
  getState: () => ReportTabsState
  setState: (next: ReportTabsState) => void
  updateDraftUrl: (draftUrl: string) => void
  loadNewTab: () => void | Promise<void>
}

/** The three things every async workspace action needs: the current state, a way to replace it, and
 * the fetcher tests substitute. */
type WorkspaceIo = {
  getState: () => ReportTabsState
  setState: (next: ReportTabsState) => void
  fetchText?: (url: string) => Promise<string>
}


// A chain, inline rather than a font or an image request: the page loads no third-party asset, and
// an icon that fails to load beside its label would look like a broken control. A chain says "link"
// where a paperclip says "attachment" - what this button hands over is a link, not a file.
const CHAIN_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
  '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'

// Names what the button produces rather than the mechanics of producing it: what a reader wants is
// a link to their report, and "copy" describes the clipboard, not the outcome.
const SHARE_LABEL = "Share Report Link"

// createShareControl builds the share button that sits to the right of the link.
function createShareControl(url: string): HTMLElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "report-share"
  const label = document.createElement("span")
  // Icon first: innerHTML replaces everything already inside, so appending the label before it would
  // silently drop the label.
  button.innerHTML = CHAIN_ICON
  label.textContent = SHARE_LABEL
  button.append(label)
  button.title = "Copy a link that reopens this report"

  button.addEventListener("click", () => {
    void copyShareLink()
  })

  async function copyShareLink(): Promise<void> {
    const link = shareLinkFor(url)
    if (!link) {
      return
    }

    try {
      await navigator.clipboard.writeText(link)
      label.textContent = "Copied"
    } catch {
      // Older browsers, and any context where the clipboard permission is refused. Selecting the
      // link is still better than telling the reader nothing happened.
      label.textContent = "Copy failed"
    }

    window.setTimeout(() => { label.textContent = SHARE_LABEL }, 1500)
  }

  return button
}

// Owns the Observable-compatible value surface while keeping the DOM shell independent of state.
function createReportWorkspaceRoot(readState: () => ReportTabsState): ReportTabsInput {
  const root = document.createElement("section");
  root.className = "report-workspace";
  Object.defineProperty(root, "value", {
    get: readState,
  });
  // defineProperty cannot widen the element's type, so the cast states the contract the property
  // just established: this node carries the current state as `value`, which is what Observable's
  // view() reads.
  return root as ReportTabsInput;
}

// Keeps the address bar carrying the active report, so a reload or a bookmark reopens what is on
// screen. replaceState rather than assigning location.hash: assigning pushes an entry, and loading
// three reports would otherwise mean three presses of Back to leave the page.
function rememberActiveReport(nextState: ReportTabsState): void {
  const location = globalThis.location;
  if (!location || !globalThis.history?.replaceState) {
    return;
  }

  const active = nextState.tabs.find((tab) => tab.id === nextState.activeTabId);
  // Falls back to the app root rather than leaving the route in place. A deleted report whose
  // token stayed in the address bar would be a link to something no longer on screen - and a
  // reload of it would bring the deleted report straight back.
  const link = active?.status === "loaded"
    ? shareLinkFor(active.loadedUrl ?? active.url)
    : appRootFor(location);

  if (link) {
    globalThis.history.replaceState(null, "", link);
  }
}

// Loads the URL currently typed into the add-report form and ignores stale async completions.
async function loadDraftReportTab({getState, setState, fetchText}: WorkspaceIo): Promise<void> {
  const requestedUrl = getState().draftUrl;
  setState({...getState(), draftStatus: "loading", draftError: undefined});
  const loadedState = await loadNewReportTabFromUrl(getState(), fetchText);
  if (getState().draftUrl !== requestedUrl) return;
  setState(loadedState);
  rememberActiveReport(loadedState);
}

// Opens the report a shared link names, with no input from the reader.
//
// Routed through the same loadNewReportTabFromUrl the form uses, so the fetch, the log-contract
// validation, the warnings and every error path are the ones already covered - a second loader for
// shared links would be a second place for them to diverge.
async function restoreSharedReport({getState, setState, fetchText}: WorkspaceIo): Promise<void> {
  const location = globalThis.location;
  // Path first - that is the form people are handed. The fragment is only the hop 404.md uses to
  // get the token into an app the host could not serve at that path directly.
  const token = reportPayloadFromPath(location?.pathname) ?? reportPayloadFromHash(location?.hash);
  if (!token) {
    return;
  }

  const decoded = decodeReportPayload(token);
  if (!decoded.ok) {
    // The link is damaged, which is a different problem from the log being unreachable, and the
    // reader can do nothing about it themselves - they never chose this URL.
    //
    // Lands on the app root, carrying nothing of the broken link. The reader must not be left on the
    // #r= hop, which is an implementation detail of the 404 shim; nor is the token worth putting
    // back into a path, because it is opaque and this one does not decode - a /r/<token> address
    // that resolves to nothing is a link that only looks usable. The token itself belongs in the
    // message, trimmed, where it identifies which link failed without pretending to be an address.
    if (location && globalThis.history?.replaceState) {
      globalThis.history.replaceState(null, "", appRootFor(location));
    }
    setState({
      ...getState(),
      isAdding: false,
      sharedLinkError: decoded.error,
      sharedLinkBroken: decoded.link
    });
    return;
  }

  // The decoded URL is handed straight to the loader and never put into rendered state. Setting
  // draftUrl here would show the add-report form while the fetch runs, with the full address
  // sitting in an input for as long as the load takes - the one place it must not appear.
  setState({
    ...getState(),
    isAdding: false,
    sharedLinkLoading: true,
    sharedLinkError: undefined,
    sharedLinkBroken: undefined
  });
  const loadedState = await loadNewReportTabFromUrl({...getState(), draftUrl: decoded.url}, fetchText);
  setState({...loadedState, draftUrl: "", sharedLinkLoading: false});
  // Puts /r/<token> back in the address bar. The fragment is an implementation detail of the hop
  // through 404.md, and leaving it on screen would mean the link someone opened is not the link
  // they could copy back out - or bookmark, or send on.
  rememberActiveReport(loadedState);
}

// Replaces the workspace in one pass so navigation and active-panel markup stay in sync.
function renderReportWorkspace(root: HTMLElement, state: ReportTabsState, actions: ReportActions): void {
  root.replaceChildren();
  root.append(createReportNavigator(state, actions), createReportActivePanel(state, actions));
}

// Builds the left-hand report picker and wires tab selection/deletion to the shared state actions.
function createReportNavigator(state: ReportTabsState, actions: ReportActions): HTMLElement {
  const navigator = document.createElement("section");
  navigator.className = "report-navigator";
  navigator.setAttribute("aria-label", "Loaded reports");

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "report-add";
  addButton.textContent = "+ Add Report";
  addButton.addEventListener("click", () => actions.setState(addReportTab(actions.getState())));
  navigator.append(addButton);

  const tabList = document.createElement("div");
  tabList.className = "report-list";
  tabList.setAttribute("role", "tablist");

  for (const tab of state.tabs) {
    tabList.append(createReportListItem(tab, state, actions));
  }

  navigator.append(tabList);
  return navigator;
}

// Builds one report tab row, including the active styling and per-tab removal control.
function createReportListItem(tab: ReportTab, state: ReportTabsState, actions: ReportActions): HTMLElement {
  const item = document.createElement("div");
  item.className = `report-list-item${tab.id === state.activeTabId ? " report-list-item-active" : ""}`;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "report-list-button";
  button.textContent = tab.label;
  // The label, not the URL. A title carrying the address puts it back in the DOM for any reader,
  // screenshot or copy-paste - the thing the share token exists to avoid.
  button.title = tab.label;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", String(tab.id === state.activeTabId));
  button.addEventListener("click", () => {
    const nextState = {...actions.getState(), activeTabId: tab.id, isAdding: false};
    actions.setState(nextState);
    // The address bar names the active report, so switching which one is active has to move it
    // too - otherwise the link on screen belongs to a tab the reader has left.
    rememberActiveReport(nextState);
  });

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "report-delete";
  removeButton.setAttribute("aria-label", `Delete ${tab.label}`);
  removeButton.textContent = "x";
  removeButton.addEventListener("click", () => {
    const nextState = deleteReportTab(actions.getState(), tab.id);
    actions.setState(nextState);
    rememberActiveReport(nextState);
  });

  item.append(button, removeButton);
  return item;
}

// Chooses between shared-link status, the active report sharing panel, and the add-report form.
function createReportActivePanel(state: ReportTabsState, actions: ReportActions): HTMLElement {
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
  const content = document.createElement("section");
  content.className = "report-active-panel";

  // A damaged token never becomes a tab, so the report-level error notice never sees it. Told
  // apart from a log that could not be retrieved on purpose: the remedies differ, and the reader
  // of a broken link can only ask for another one.
  if (state.sharedLinkLoading) {
    const pending = document.createElement("p");
    pending.className = "source-line";
    pending.textContent = "Opening the shared report...";
    content.append(pending);
  }

  if (state.sharedLinkError) {
    const notice = document.createElement("p");
    notice.className = "report-share-error";
    notice.textContent = state.sharedLinkError;
    if (state.sharedLinkBroken) {
      // A <code> element, not more prose: an opaque address set in the body face runs straight into
      // the sentence around it, and the one thing a reader needs to pick out is where the link ends.
      notice.append(" (broken link: ");
      const link = document.createElement("code");
      link.className = "report-broken-link";
      link.textContent = state.sharedLinkBroken;
      notice.append(link, ")");
    }
    content.append(notice);
  }

  if (!state.isAdding && activeTab) {
    const sourceUrl = activeTab.loadedUrl ?? activeTab.url;
    // The share link, not the log address. Showing both was showing the same thing twice - the
    // link encodes the address, and a reader who needs the address can get it from the link - so
    // the only thing the second copy added was the address itself, in readable form, on a panel
    // people screenshot. The report is identified by its label in the tab strip and in the
    // "Analyzing" line, so nothing is lost by dropping it.
    const shareLink = activeTab.status === "loaded" ? shareLinkFor(sourceUrl) : null;
    if (shareLink) {
      // Shown whole, not trimmed. A trimmed log address was a courtesy - host and filename told a
      // reader which report they had. A trimmed *link* is just broken: its whole value is being
      // copied, and an ellipsis in the middle of it means anyone selecting it by hand gets
      // something that does not work. It wraps instead.
      const panel = document.createElement("div");
      panel.className = "report-share-panel";

      const source = document.createElement("p");
      source.className = "report-source-url";
      source.textContent = shareLink;

      panel.append(source, createShareControl(sourceUrl));
      content.append(panel);
    }

    return content;
  }

  if (state.isAdding) {
    content.append(createReportUrlForm(state, actions));
  }

  return content;
}

// Builds the online-log URL form used when the reader adds another report.
function createReportUrlForm(state: ReportTabsState, actions: ReportActions): HTMLElement {
  const form = document.createElement("form");
  form.className = "report-url-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void actions.loadNewTab();
  });

  const inputId = `${state.pendingTabId ?? "new-report"}-url`;
  const label = document.createElement("label");
  label.textContent = "Online JSON file URL";
  label.htmlFor = inputId;

  const input = document.createElement("input");
  input.id = inputId;
  input.type = "url";
  input.placeholder = "https://example.com/tapoo-v2.5.1-agent-api-logs-1788023517.json";
  input.value = state.draftUrl;
  input.addEventListener("input", () => {
    actions.updateDraftUrl(input.value);
  });

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = state.draftStatus === "loading" ? "Loading..." : "Load report";
  submit.disabled = state.draftStatus === "loading";

  form.append(label, input, submit);
  if (state.draftStatus === "error") {
    const error = document.createElement("p");
    error.className = "report-url-error";
    error.textContent = state.draftError ?? null;
    form.append(error);
  }

  return form;
}

// Creates the Observable input node that owns report-tab state and emits input events on changes.
export function createReportTabsInput(
  {fetchText}: {fetchText?: (url: string) => Promise<string>} = {},
): ReportTabsInput {
  let state = createInitialReportTabs();
  const root = createReportWorkspaceRoot(() => state);

  const dispatchInput = (): void => {
    root.dispatchEvent(new Event("input", {bubbles: true}));
  };

  const setState = (nextState: ReportTabsState): void => {
    state = nextState;
    dispatchInput();
    renderReportWorkspace(root, state, actions);
  };

  const updateDraftUrl = (draftUrl: string): void => {
    state = {...state, draftUrl, draftStatus: "empty", draftError: undefined};
    dispatchInput();
  };

  // Declared here rather than above the handlers that close over it: every one of those references
  // runs from an event, long after this line, so the binding they capture is always initialised.
  const actions: ReportActions = {
    getState: () => state,
    setState,
    updateDraftUrl,
    loadNewTab: () => loadDraftReportTab({getState: () => state, setState, fetchText})
  };

  renderReportWorkspace(root, state, actions);
  void restoreSharedReport({getState: () => state, setState, fetchText});
  return root;
}
