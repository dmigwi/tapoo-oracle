// Report tabs: one loaded log per tab, and the state that tracks them.
//
// Pure - no document, no Observable globals. The control that renders these lives in
// report-tabs-control.ts; keeping the reducers here is what lets them be tested in node.

import { loadTapooLogFromUrl } from "./share-link"
import { parseTapooLogText } from "./log-contract"
import { answerRubric } from "./report"
import type { Analysis, ReportTab, ReportTabsState, TapooLog } from "./types"
import {asTrimmedText} from "./untrusted";


// analyzeLogText is the single entry point from raw text to a rendered result. It returns a
// discriminated result instead of throwing, because every failure here is a person's input mistake
// that the page has to explain, not an exceptional condition.
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

function buildReportAnalysis(source: TapooLog, warnings: string[], label: string): Analysis {
  return {
    ok: true,
    source,
    warnings,
    report: answerRubric(source.entries, {label})
  };
}

function reportTabId(): string {
  if (globalThis.crypto?.randomUUID) {
    return `report-${globalThis.crypto.randomUUID()}`;
  }
  return `report-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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

export function trimReportTabLabel(value: unknown, maxLength = 34): string {
  const label = asTrimmedText(value);
  if (label.length <= maxLength) return label;
  return `...${label.slice(-(maxLength - 3))}`;
}

export function createEmptyReportTab(id: string = reportTabId()): ReportTab {
  return {
    id,
    url: "",
    label: "New report",
    status: "empty",
  };
}

export function createInitialReportTabs(): ReportTabsState {
  return {
    tabs: [],
    activeTabId: null,
    isAdding: true,
    draftUrl: "",
    draftStatus: "empty",
  };
}

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

  const nextIndex = Math.min(Math.max(deletedIndex, 0), tabs.length - 1);
  return {...state, tabs, activeTabId: tabs[nextIndex]?.id ?? null};
}

// --- Loading a report ---

const fetchOptions = (fetchText?: (url: string) => Promise<string>) =>
  fetchText ? {fetchText} : undefined;

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
