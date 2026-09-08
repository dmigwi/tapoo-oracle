// Report tabs: one loaded log per tab, and the state that tracks them.
//
// Pure - no document, no Observable globals. The control that renders these lives in
// report-tabs-control.ts; keeping the reducers here is what lets them be tested in node.

import { loadTapooLogFromUrl } from "./share-link"
import { parseTapooLogText } from "./log-contract"
import { answerRubric } from "./report"
import { groupEntriesByRound, roundLabel } from "./rounds"
import type { Analysis, LogWarning, ReportTab, ReportTabsState, TapooLog } from "./types"
import {asTrimmedText, clamp} from "./utils";


/** analyzeLogText is the single entry point from raw text to a rendered result. It returns a
 * discriminated result instead of throwing, because every failure here is a person's input mistake
 * that the page has to explain, not an exceptional condition. */
export function analyzeLogText(
  text: unknown,
  {label = "online log", sourceUrl}: {label?: string; sourceUrl?: string} = {},
): Analysis {
  const result = parseTapooLogText(text, {sourceUrl});
  if (!result.ok) {
    return {ok: false, error: result.error};
  }

  return buildReportAnalysis(result.source, result.warnings, label);
}

// One report per round, not one per log.
//
// A Tapoo log is a sequence of independent games: a new maze, a new start cell, a fresh decay budget.
// Aggregating them produced verdicts that belonged to no maze in particular - a capability answered YES
// because round 3 showed it, printed above round 1's replay - and a "Rounds" count that existed only to
// admit the report was a blend. Answering the rubric per round costs one extra pass over entries
// already in memory and makes every verdict on screen a statement about the maze beside it.
function buildReportAnalysis(source: TapooLog, warnings: LogWarning[], label: string): Analysis {
  const rounds = groupEntriesByRound(source.entries).map(({key, game, level, entries}) => ({
    key,
    game,
    level,
    label: roundLabel({game, level}),
    // The round's own label, so a warning or an error raised while answering names the round rather
    // than the file - the file is already on screen above the tabs.
    report: answerRubric(entries, {label: `${label} - ${roundLabel({game, level})}`}),
  }));

  return {
    ok: true,
    source,
    warnings,
    rounds,
  };
}

function reportTabId(): string {
  if (globalThis.crypto?.randomUUID) {
    return `report-${globalThis.crypto.randomUUID()}`;
  }
  return `report-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Names a tab after the file it loaded: the last path segment, else the host, else "Report N".
 *
 * Every arm falls back rather than throwing - this runs on a URL that has already been validated, but
 * naming a tab must not be able to fail the load that produced it. */
export function reportTabLabelFromUrl(value: string, index = 0): string {
  const fallback = `Report ${index + 1}`;
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
    return trimReportTabLabel(name || url.hostname || fallback);
  } catch {
    return fallback;
  }
}

/** Shortens a label to fit a tab, keeping the *end*.
 *
 * The tail is the discriminating half: logs from one run share a directory and differ in the file name,
 * so trimming from the right would leave a row of tabs reading the same thing. */
export function trimReportTabLabel(value: unknown, maxLength = 34): string {
  const label = asTrimmedText(value);
  if (label.length <= maxLength) return label;
  return `...${label.slice(-(maxLength - 3))}`;
}

/** A tab with no log in it yet: an id and somewhere to type a URL. */
export function createEmptyReportTab(id: string = reportTabId()): ReportTab {
  return {
    id,
    url: "",
    label: "New report",
    status: "empty",
  };
}

/** The state the page opens in: no tabs, and the add-a-report field already showing. */
export function createInitialReportTabs(): ReportTabsState {
  return {
    tabs: [],
    activeTabId: null,
    isAdding: true,
    draftUrl: "",
    draftStatus: "empty",
  };
}

/** Opens the draft field for a new report, remembering the id the tab will take once it loads.
 *
 * No tab is appended here. A tab only exists once a load has produced something to put in it, so
 * cancelling the draft leaves no empty tab behind. */
export function addReportTab(state: ReportTabsState, id: string = reportTabId()): ReportTabsState {
  return {
    ...state,
    pendingTabId: id,
    isAdding: true,
    draftUrl: "",
    draftStatus: "empty",
    draftError: undefined,
  };
}

/** Replaces one tab's fields, leaving the rest of the state alone. Returns a new state rather than
 * mutating - the control repaints from whatever it is handed, so an in-place edit would not be drawn. */
export function updateReportTab(
  state: ReportTabsState,
  tabId: string,
  patch: Partial<ReportTab>,
): ReportTabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? {...tab, ...patch} : tab)),
  };
}

/** Removes a tab and decides what the reader looks at next.
 *
 * Activation only moves when the *active* tab is the one closed; closing a background tab must not
 * change what is on screen. The successor is the tab that took the deleted one's position, or the new
 * last tab when the deleted one was at the end. Removing the last tab of all returns the opening
 * state, so the page offers a URL field rather than an empty frame. */
export function deleteReportTab(
  state: ReportTabsState,
  tabId: string,
  createId: () => string = reportTabId,
): ReportTabsState {
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

  const nextIndex = clamp(deletedIndex, 0, tabs.length - 1);
  return {...state, tabs, activeTabId: tabs[nextIndex]?.id ?? null};
}

// --- Loading a report ---

const fetchOptions = (fetchText?: (url: string) => Promise<string>) =>
  fetchText ? {fetchText} : undefined;

/** Loads the drafted URL and appends the tab it produced.
 *
 * A failure with a URL still becomes a tab, carrying its error: the reader typed an address that
 * validated, and a tab they can retry or correct is more use than an error message and nothing to
 * attach it to. A failure with no URL never validated, so it stays in the draft field instead.
 *
 * `fetchText` is injectable for the suites. */
export async function loadNewReportTabFromUrl(
  state: ReportTabsState,
  fetchText?: (url: string) => Promise<string>,
): Promise<ReportTabsState> {
  const tabId = state.pendingTabId ?? reportTabId();
  const loaded = await loadTapooLogFromUrl(state.draftUrl, fetchOptions(fetchText));
  if (!loaded.ok && !loaded.url) {
    return {
      ...state,
      isAdding: true,
      draftStatus: "error",
      draftError: loaded.error,
    };
  }

  const label = reportTabLabelFromUrl(loaded.url ?? state.draftUrl, state.tabs.length);
  const baseTab = {
    id: tabId,
    url: loaded.url ?? state.draftUrl,
    label,
    loadedUrl: loaded.url,
  };

  const result = loaded.ok ? buildReportAnalysis(loaded.source, loaded.warnings, label) : undefined;
  const tab: ReportTab = loaded.ok
    ? {...baseTab, status: "loaded", result, error: undefined}
    : {...baseTab, status: "error", result, error: loaded.error};
  return {
    ...state,
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
    isAdding: false,
    draftUrl: "",
    draftStatus: "empty" as const,
    draftError: undefined,
    pendingTabId: undefined,
  };
}

/** Reloads an existing tab from the URL it currently holds - the retry path, and the path a reader
 * takes after editing a tab's address.
 *
 * Same rule on failure as the load above: a URL that validated leaves the tab in place carrying its
 * error, so `loadedUrl` and the displayed report stay together or are cleared together. */
export async function loadReportTabFromUrl(
  state: ReportTabsState,
  tabId: string,
  fetchText?: (url: string) => Promise<string>,
): Promise<ReportTabsState> {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  const loaded = await loadTapooLogFromUrl(tab?.url, fetchOptions(fetchText));
  if (!loaded.ok && !loaded.url) {
    return updateReportTab(state, tabId, {
      status: "error",
      error: loaded.error,
      result: undefined,
      loadedUrl: undefined,
    });
  }

  const label = reportTabLabelFromUrl(
    loaded.url ?? "",
    state.tabs.findIndex((candidate) => candidate.id === tabId),
  );
  const result = loaded.ok ? buildReportAnalysis(loaded.source, loaded.warnings, label) : undefined;
  return updateReportTab(
    state,
    tabId,
    loaded.ok
      ? {status: "loaded", label, result, loadedUrl: loaded.url, error: undefined}
      : {status: "error", label, result, loadedUrl: loaded.url, error: loaded.error},
  );
}
