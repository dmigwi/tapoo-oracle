// Log tabs: one loaded log per tab, and the state that tracks them.
//
// The outer strip. A log tab holds one downloaded log; the round tabs inside a report pick which
// game identity within that log is on screen. "Report" here means the analysis, never a tab.
//
// Pure - no document, no Observable globals. The control that renders these lives in
// log-tabs-control.ts; keeping the reducers here is what lets them be tested in node.
//
// In the order a tab lives: the state reducers first, then loading a log into a tab, then reading
// what was loaded - the slices, and the round a reader opened.

import { agentSettingsCheck, parseGameRound, seatRosterCheck } from "./log-contract"
import { loadTapooLogFromUrl } from "./share-link"
import { buildReport } from "./rubric-report"
import { groupEntriesByRound, roundLabel } from "./rounds"
import type { SlicedLogResult, LogTab, LogTabsState, ParsedLog, RoundReport, RoundSlice } from "./types"
import {asTrimmedText, clamp} from "./utils";

// --- Entry points: what log-tabs-control calls ---
//
// The tab-state reducers. createInitialLogTabs is also report-view's, for a page with no tabs yet.

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

function logTabId(): string {
  return `report-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// --- Entry points: what log-tabs-control calls to load a log ---

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
  const loaded = await loadLogTabFields(state.draftUrl, state.tabs.length, fetchText);
  if ("unvalidated" in loaded) {
    return {
      ...state,
      isAdding: true,
      draftStatus: "error",
      draftError: loaded.unvalidated,
    };
  }

  const tab: LogTab = {id: state.pendingTabId ?? logTabId(), ...loaded};

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
 * one click rather than retyping. It builds its fields through the same loadLogTabFields the add path
 * uses, so a report that arrives by retry cannot differ from one that arrived first time.
 *
 * A URL that never validated clears the tab's report rather than leaving a stale one beside a fresh
 * error: `loadedUrl` and the displayed report stay together or are cleared together. */
export async function loadLogTabFromUrl(
  state: LogTabsState,
  tabId: string,
  fetchText?: (url: string) => Promise<string>,
): Promise<LogTabsState> {
  const index = state.tabs.findIndex((candidate) => candidate.id === tabId);
  const loaded = await loadLogTabFields(state.tabs[index]?.url, index, fetchText);
  if ("unvalidated" in loaded) {
    return updateLogTab(state, tabId, {
      status: "error",
      error: loaded.unvalidated,
      result: undefined,
      loadedUrl: undefined,
    });
  }

  return updateLogTab(state, tabId, loaded);
}

const fetchOptions = (fetchText?: (url: string) => Promise<string>) =>
  fetchText ? {fetchText} : undefined;

/** What loading one URL produced: either an address that never validated, or a whole log tab bar its id.
 *
 * Two arms rather than one shape with optional fields, so a caller cannot read a tab's fields off a
 * failure: narrowing on `unvalidated` is what hands it the rest. The same reason Result is a union - see
 * its note in types.ts.
 *
 * Not Result itself, though: `ok: false` would read as "the load failed", and here a load that failed is
 * a *success* - it carries its error as the tab's own `error`, because the URL validated and the reader
 * gets a tab they can retry. `unvalidated` means only that the address never validated.
 *
 * `Omit<LogTab, "id">` rather than fields of its own: everything a load decides is something a tab
 * holds, and the id is the one thing it does not - the add path mints one, the reload path already has
 * one. Naming the tab's own shape is what keeps a field added to LogTab from being silently dropped
 * here. */
type LoadedLogTabFields = {unvalidated: string} | Omit<LogTab, "id">;

/** loadLogTabFields fetches one URL and turns it into a log tab, bar its id.
 *
 * The half the add and reload paths share, so a tab that arrives by retry cannot differ from one that
 * arrived first time.
 *
 * `unvalidated` is returned separately because it is the one outcome the two callers handle differently:
 * the add path has no tab to attach the error to and leaves it in the draft field, while the reload path
 * has a tab sitting right there. */
async function loadLogTabFields(
  url: unknown,
  index: number,
  fetchText?: (url: string) => Promise<string>,
): Promise<LoadedLogTabFields> {
  const loaded = await loadTapooLogFromUrl(url, fetchOptions(fetchText));
  if (!loaded.ok && !loaded.url) {
    return {unvalidated: loaded.error};
  }

  // Past the guard above, a load that failed still validated, so it has a URL to name.
  const resolved = loaded.url ?? asTrimmedText(url);
  const label = extractTabLabelFromUrl(resolved, index);

  return {
    url: resolved,
    label,
    status: loaded.ok ? "loaded" : "error",
    result: loaded.ok ? sliceLogIntoRounds(loaded, label) : undefined,
    loadedUrl: loaded.url,
    error: loaded.ok ? undefined : loaded.error,
  };
}

/** Names a tab after the file it loaded: the last path segment, else the host, else "Report N", and
 * shortened to fit a tab.
 *
 * Shortened from the left, keeping the *end*: logs from one run share a directory and differ in the file
 * name, so trimming the tail would leave a row of tabs reading the same thing.
 *
 * Every arm falls back rather than throwing - this runs on a URL that has already been validated, but
 * naming a tab must not be able to fail the load that produced it. */
export function extractTabLabelFromUrl(value: string, index = 0, maxLength = 34): string {
  const fallback = `Report ${index + 1}`;

  let label: string;
  try {
    const url = new URL(value);
    label = asTrimmedText(decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "")) || url.hostname;
  } catch {
    return fallback;
  }

  if (!label) return fallback;
  return label.length <= maxLength ? label : `...${label.slice(-(maxLength - 3))}`;
}

/** sliceLogIntoRounds cuts a parsed log into one slice per round, passing the log's warnings and checks
 * through untouched.
 *
 * A round is the unit every verdict is about: each is an independent game with its own maze, start cell
 * and decay budget.
 *
 * A slice is entries and an identity, so this costs no rubric pass - that is roundReportFor's, run for
 * the round a reader opens. */
export function sliceLogIntoRounds({source, warnings, checks}: ParsedLog, label: string): SlicedLogResult {
  const [first, ...rest]: RoundSlice[] = groupEntriesByRound(source.entries).map(({identity, entries}) => ({
    identity,
    reportLabel: `${label} - ${roundLabel(identity)}`,
    entries,
  }));

  // Unreachable: parseTapooLogText refuses a log with no readable entries, and groupEntriesByRound
  // groups any non-empty list - a log naming no round still gets one holding everything. Stated once
  // here, so no render has to guard the empty case.
  if (!first) {
    return {ok: false, error: "This log analyzed to no rounds, so there is nothing to report."};
  }

  return {
    ok: true,
    source,
    warnings,
    checks,
    rounds: [first, ...rest],
  };
}

// --- Entry point: what report-view calls ---

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
 * for the round a reader actually opened, rather than all fourteen of a fourteen-round file up front.
 *
 * Memoized, so returning to a round is free and the object identity of what the view holds is stable
 * across renders. */
export function roundReportFor(slice: RoundSlice): RoundReport {
  const cached = answered.get(slice);
  if (cached) return cached;

  const report = buildReport(slice.entries, {label: slice.reportLabel});
  const round = parseGameRound(slice.entries);
  const resolved: RoundReport = {
    ...slice,
    report,
    // Composed here because the check needs both halves: parseGameRound reads the round's payloads and
    // knows nothing of seats, while the summaries come from the answered report. Neither should have to
    // reach for the other to say whether a seat's setup held for the whole round.
    round: {
      ...round,
      checks: [
        ...round.checks,
        // Over the round's turns, which is where a seat and a player are stated together. A round that
        // decoded no maze still has turns to check, so this reads the turns and not the maze.
        seatRosterCheck(report.level?.turns ?? []),
        agentSettingsCheck(report.agents),
      ],
    },
  };
  answered.set(slice, resolved);
  return resolved;
}
