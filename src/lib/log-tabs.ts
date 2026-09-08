// Log tabs: one loaded log per tab, and the state that tracks them.
//
// The outer strip. A log tab holds one downloaded log; the round tabs inside a report pick which
// game identity within that log is on screen. "Report" here means the analysis, never a tab.
//
// Pure - no document, no Observable globals. The control that renders these lives in
// log-tabs-control.ts; keeping the reducers here is what lets them be tested in node.

import { parseGameRound } from "./log-contract"
import { loadTapooLogFromUrl } from "./share-link"
import { answerRubric } from "./report"
import { groupEntriesByRound, roundLabel } from "./rounds"
import type { Analysis, LogWarning, LogTab, LogTabsState, RoundReport, RoundSlice, TapooLog } from "./types"
import {asTrimmedText, clamp} from "./utils";


/** buildReportAnalysis answers the rubric for a parsed log: one report per round, not one per log.
 *
 * A Tapoo log is a sequence of independent games: a new maze, a new start cell, a fresh decay budget.
 * Aggregating them produced verdicts that belonged to no maze in particular - a capability answered YES
 * because round 3 showed it, printed above round 1's replay - and a "Rounds" count that existed only to
 * admit the report was a blend. Answering the rubric per round costs one extra pass over entries
 * already in memory and makes every verdict on screen a statement about the maze beside it.
 *
 * The step both loaders share, and the only one that turns a log into verdicts. Exported so a test can
 * reach it from text without a network - see analyzeLogText in test-support.ts. */
export function buildReportAnalysis(source: TapooLog, warnings: LogWarning[], label: string): Analysis {
  const rounds: RoundSlice[] = groupEntriesByRound(source.entries).map(({key, game, level, entries}) => ({
    key,
    game,
    level,
    label: roundLabel({game, level}),
    reportLabel: `${label} - ${roundLabel({game, level})}`,
    entries,
  }));

  return {
    ok: true,
    source,
    warnings,
    rounds,
  };
}

// Answered rounds, keyed by the slice they were answered from.
//
// A WeakMap rather than a field on the slice: the slices live inside a log tab's state, which the
// reducers replace wholesale on every change, and a cache written into that state would either be
// copied around or mutated in place. Keyed by object identity instead, so it survives a re-render -
// updateLogTab keeps `result` by reference - and is collected with the tab when it closes.
const answered = new WeakMap<RoundSlice, RoundReport>();

/** roundReportFor answers one round, once: its rubric verdicts and its own caveats.
 *
 * This is where a log stops being cheap. Opening a file reads its envelope and slices it into rounds;
 * everything expensive - the rubric pass, the maze decode, the checksum reconstruction - happens here,
 * for the round a reader actually opened. A file of fourteen rounds used to do all fourteen up front.
 *
 * Memoized, so returning to a round is free and the object identity of what the view holds is stable
 * across renders. */
export function roundReportFor(slice: RoundSlice): RoundReport {
  const cached = answered.get(slice);
  if (cached) return cached;

  const resolved: RoundReport = {
    ...slice,
    report: answerRubric(slice.entries, {label: slice.reportLabel}),
    round: parseGameRound(slice.entries),
  };
  answered.set(slice, resolved);
  return resolved;
}

function logTabId(): string {
  if (globalThis.crypto?.randomUUID) {
    return `report-${globalThis.crypto.randomUUID()}`;
  }
  return `report-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Names a tab after the file it loaded: the last path segment, else the host, else "Report N".
 *
 * Every arm falls back rather than throwing - this runs on a URL that has already been validated, but
 * naming a tab must not be able to fail the load that produced it. */
export function logTabLabelFromUrl(value: string, index = 0): string {
  const fallback = `Report ${index + 1}`;
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
    return trimLogTabLabel(name || url.hostname || fallback);
  } catch {
    return fallback;
  }
}

/** Shortens a label to fit a tab, keeping the *end*.
 *
 * The tail is the discriminating half: logs from one run share a directory and differ in the file name,
 * so trimming from the right would leave a row of tabs reading the same thing. */
export function trimLogTabLabel(value: unknown, maxLength = 34): string {
  const label = asTrimmedText(value);
  if (label.length <= maxLength) return label;
  return `...${label.slice(-(maxLength - 3))}`;
}

/** A tab with no log in it yet: an id and somewhere to type a URL. */
export function createEmptyLogTab(id: string = logTabId()): LogTab {
  return {
    id,
    url: "",
    label: "New report",
    status: "empty",
  };
}

/** The state the page opens in: no tabs, and the add-a-log field already showing. */
export function createInitialLogTabs(): LogTabsState {
  return {
    tabs: [],
    activeTabId: null,
    isAdding: true,
    draftUrl: "",
    draftStatus: "empty",
  };
}

/** Opens the draft field for a new log, remembering the id the tab will take once it loads.
 *
 * No tab is appended here. A tab only exists once a load has produced something to put in it, so
 * cancelling the draft leaves no empty tab behind. */
export function addLogTab(state: LogTabsState, id: string = logTabId()): LogTabsState {
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
export function updateLogTab(
  state: LogTabsState,
  tabId: string,
  patch: Partial<LogTab>,
): LogTabsState {
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
export function deleteLogTab(
  state: LogTabsState,
  tabId: string,
  createId: () => string = logTabId,
): LogTabsState {
  const deletedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) {
    return {
      ...createInitialLogTabs(),
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

/** loadTabFields fetches one URL and turns it into the fields a tab carries.
 *
 * The half both loaders share, extracted because it is the half where a divergence would be a bug: the
 * two used to build `{status, result, loadedUrl, error}` separately, and nothing would have caught them
 * disagreeing about whether a failed reload keeps its stale report. They already disagreed harmlessly -
 * one wrote `loaded.url ?? state.draftUrl` for the label, the other `loaded.url ?? ""`.
 *
 * `unvalidated` is the one outcome the callers must handle differently, so it is returned rather than
 * folded in: a URL that never validated has no tab to attach an error to on the add path, which is why
 * that path leaves it in the draft field, while the reload path has a tab sitting right there.
 */
type LoadedTabFields =
  | {unvalidated: string}
  | {unvalidated?: undefined; label: string; url: string; fields: Partial<LogTab>};

async function loadTabFields(
  url: unknown,
  index: number,
  fetchText?: (url: string) => Promise<string>,
): Promise<LoadedTabFields> {
  const loaded = await loadTapooLogFromUrl(url, fetchOptions(fetchText));
  if (!loaded.ok && !loaded.url) {
    return {unvalidated: loaded.error};
  }

  // Past the guard above, a load that failed still validated, so it has a URL to name.
  const resolved = loaded.url ?? asTrimmedText(url);
  const label = logTabLabelFromUrl(resolved, index);
  const result = loaded.ok ? buildReportAnalysis(loaded.source, loaded.warnings, label) : undefined;

  return {
    label,
    url: resolved,
    fields: loaded.ok
      ? {status: "loaded", label, result, loadedUrl: loaded.url, error: undefined}
      : {status: "error", label, result, loadedUrl: loaded.url, error: loaded.error},
  };
}

/** Loads the drafted URL and appends the tab it produced.
 *
 * A failure with a URL still becomes a tab, carrying its error: the reader typed an address that
 * validated, and a tab they can retry or correct is more use than an error message and nothing to
 * attach it to. A failure with no URL never validated, so it stays in the draft field instead.
 *
 * `fetchText` is injectable for the suites. */
export async function loadNewLogTabFromUrl(
  state: LogTabsState,
  fetchText?: (url: string) => Promise<string>,
): Promise<LogTabsState> {
  const loaded = await loadTabFields(state.draftUrl, state.tabs.length, fetchText);
  if (loaded.unvalidated !== undefined) {
    return {
      ...state,
      isAdding: true,
      draftStatus: "error",
      draftError: loaded.unvalidated,
    };
  }

  const tab: LogTab = {
    id: state.pendingTabId ?? logTabId(),
    url: loaded.url,
    label: loaded.label,
    status: "empty",
    ...loaded.fields,
  };

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

/** Reloads an existing tab from the URL it currently holds, replacing its report in place.
 *
 * The retry a reader reaches for when a load failed - the tab keeps its address, so trying again is
 * one click rather than retyping. It builds its fields through the same loadTabFields the add path
 * uses, so a report that arrives by retry cannot differ from one that arrived first time.
 *
 * A URL that never validated clears the tab's report rather than leaving a stale one beside a fresh
 * error: `loadedUrl` and the displayed report stay together or are cleared together. */
export async function loadLogTabFromUrl(
  state: LogTabsState,
  tabId: string,
  fetchText?: (url: string) => Promise<string>,
): Promise<LogTabsState> {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  const index = state.tabs.findIndex((candidate) => candidate.id === tabId);
  const loaded = await loadTabFields(tab?.url, index, fetchText);
  if (loaded.unvalidated !== undefined) {
    return updateLogTab(state, tabId, {
      status: "error",
      error: loaded.unvalidated,
      result: undefined,
      loadedUrl: undefined,
    });
  }

  return updateLogTab(state, tabId, loaded.fields);
}
