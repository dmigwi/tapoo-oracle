// What the first scan of a downloaded log produces, beside the entries themselves.
//
// One pass over the validated entries yields two things every later reader wants: a summary of what
// the log contains, and a map of where each turn begins and ends. Before this, a turn was something
// each consumer re-derived by walking the whole array with a cursor, and "what is in this log" was not
// answered anywhere at all.
//
// The index describes the log. It does not interpret it: no rubric question is answered here, and no
// verdict depends on anything in this file. That separation is deliberate - the summary is meant to be
// readable and cheap, and a reader should be able to trust it without knowing the rubric.

import {EVENT_CLASSES, KNOWN_EVENTS, levelClassOf} from "./log-events";
import type {LogEntry, LogIndex, LogSummary, TurnIdentity, TurnSpan} from "./types";

/** True when every entry carries a turn number.
 *
 * Logs written before the turn counter landed carry none, and their boundaries can only be inferred
 * from predictions - which buildContext still does for itself, because inferring them needs to know
 * what a parsed prediction is. Rather than reproduce that here and risk two disagreeing answers, the
 * index reports that it cannot say. */
const hasTurnNumbers = (entries: LogEntry[]): boolean =>
  entries.length > 0 && entries.every((entry) => typeof entry.turn === "number");

// turnSpans cuts the entries into half-open ranges, one per turn.
//
// Tapoo resets turn numbers for every round, so the complete identity is (game, level, turn). Modern
// logs stamp all three fields; null preserves the limited identity available in older logs.
export function turnIdentityKey({game, level, turn}: TurnIdentity): string {
  return `${game ?? "?"}/${level ?? "?"}/${turn}`;
}

function turnSpans(entries: LogEntry[]): TurnSpan[] {
  const spans: TurnSpan[] = [];
  let current: TurnSpan | null = null;

  for (const [index, entry] of entries.entries()) {
    const turn = entry.turn;
    if (typeof turn !== "number") continue;

    const identity = {game: entry.game ?? null, level: entry.level ?? null, turn};
    if (current && turnIdentityKey(current) === turnIdentityKey(identity)) {
      current.end = index + 1;
      continue;
    }

    current = {...identity, start: index, end: index + 1};
    spans.push(current);
  }

  return spans;
}

function summarize(entries: LogEntry[], turns: number): LogSummary {
  const levels = {error: 0, info: 0, warn: 0};
  const events = new Map<string, number>();
  let penalised = 0;
  let external = 0;
  let firstEpochMs: number | null = null;
  let lastEpochMs: number | null = null;

  for (const entry of entries) {
    levels[entry.log] += 1;
    events.set(entry.payload, (events.get(entry.payload) ?? 0) + 1);

    // Counted from the level, not the payload, so an event the rubric has never heard of still lands
    // in the right column.
    const kind = levelClassOf(entry.log);
    if (kind === "penalised") penalised += 1;
    if (kind === "external") external += 1;

    if (Number.isFinite(entry.epochMs)) {
      if (firstEpochMs === null || entry.epochMs < firstEpochMs) firstEpochMs = entry.epochMs;
      if (lastEpochMs === null || entry.epochMs > lastEpochMs) lastEpochMs = entry.epochMs;
    }
  }

  return {entries: entries.length, turns, levels, events, penalised, external, firstEpochMs, lastEpochMs};
}

/** Builds the index. Called once, by the parse that validated these entries. */
export function indexLog(entries: LogEntry[]): LogIndex {
  const indexed = hasTurnNumbers(entries);
  const turns = indexed ? turnSpans(entries) : [];

  return {
    summary: summarize(entries, turns.length),
    turnSource: indexed ? "field" : "unavailable",
    turns,
    byTurn: new Map(turns.map((span) => [turnIdentityKey(span), span])),
  };
}

/** The entries belonging to one turn, or an empty list when the index cannot place it. */
export function entriesForTurn(entries: LogEntry[], index: LogIndex, identity: TurnIdentity): LogEntry[] {
  const span = index.byTurn.get(turnIdentityKey(identity));
  return span ? entries.slice(span.start, span.end) : [];
}

// unknownEvents lists payload sentences the rubric has no question for, with how often each occurred.
//
// Deliberately not shown to a reader. "This event is not scored" describes work not yet done here, and
// the reader's warning banner is for caveats about the log itself - things that bound how much the
// verdicts are worth and that they can weigh. The proper answer to an unscored event is a fact
// question that scores it; this is the tool for finding which ones are missing.
export function unknownEvents(index: LogIndex): Array<{payload: string; count: number}> {
  return [...index.summary.events]
    .filter(([payload]) => !KNOWN_EVENTS.has(payload))
    .map(([payload, count]) => ({payload, count}));
}

// levelDisagreements reports entries whose level contradicts the class its payload implies.
//
// Only known events can disagree: an unknown one has nothing to contradict. A disagreement means the
// producer and this file describe the same event differently - a bug in one of them, and not something
// a reader of the report can act on, so like unknownEvents it stays out of the warning banner. Nothing
// here changes a count or a verdict either: the finding is for whoever fixes the mismatch.
export function levelDisagreements(
  entries: LogEntry[],
): Array<{payload: string; expected: string; actual: string; count: number}> {
  const found = new Map<string, {payload: string; expected: string; actual: string; count: number}>();

  for (const entry of entries) {
    const expected = EVENT_CLASSES[entry.payload];
    if (expected === undefined) continue;

    const actual = levelClassOf(entry.log);
    if (actual === expected) continue;

    const key = `${entry.payload}|${actual}`;
    const seen = found.get(key);
    if (seen) seen.count += 1;
    else found.set(key, {payload: entry.payload, expected, actual, count: 1});
  }

  return [...found.values()];
}
