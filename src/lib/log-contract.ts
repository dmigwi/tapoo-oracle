// Tapoo agent-api log contract.
//
// This module is the single definition of what a downloaded Tapoo log looks like, shared by every
// consumer that reads one: the CLI in scripts/agentic-analysis.mjs, and the Oracle analytics app in
// src/. There is exactly one copy, so the two front ends cannot answer the same log differently.
//
// It deliberately imports no dependencies and no node: builtins, so it runs unchanged in Node and in a
// browser bundle.
//
// The producer of this shape is frontend/app/logs.ts (tapooDownloadLogs) writing entries typed as
// LogEntry in frontend/app/types.ts. When that producer changes, this file changes with it, and
// LOG_CONTRACT_VERSION below is what tells a consumer it is looking at something it does not know
// how to read.

import type {
  EncodedMaze,
  LogWarning,
  LogEntry,
  LogParseResult,
  LogTextResult,
  TapooLog,
} from "./types";

import {asTrimmedText} from "./untrusted";
import {indexLog} from "./log-index";
import {mazeFromEncoded} from "./maze";

export {
  AGENT_API_MODE,
  DECLARED_TOOLS,
  EVENT_CLASSES,
  KNOWN_EVENTS,
  LOG_CONTRACT_VERSION,
  LOG_ENVELOPE_NAME,
  LOG_EVENTS,
  LOG_LEVELS,
  levelClassOf,
} from "./log-events";
import {AGENT_API_MODE, LOG_ENVELOPE_NAME, LOG_EVENTS, LOG_LEVELS} from "./log-events";

// Re-exported: every caller of these is reading the log contract, and that is still where they look.
export {
  MOVES,
  cellFromLogged,
  cellKey,
  classifyTraversalSpeed,
  isMove,
  movesFromLogged,
  stepFrom,
} from "./geometry";

// --- Validating an export ---

// isLogEntry reports whether one array element carries the fields every consumer relies on. turn,
// level, and game are checked but not required to be present: logs written before those counters
// landed still analyze correctly, and buildContext has an explicit fallback for a missing turn.
function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.payload === "string" &&
    typeof entry.epochMs === "number" &&
    typeof entry.log === "string" &&
    LOG_LEVELS.has(entry.log)
  );
}

// parseTapooLogExport validates a parsed JSON value against the envelope contract and returns a
// discriminated result rather than throwing, because both consumers report the failure to a person:
// the CLI prints it, the Oracle renders it beside the input.
//
// The check is strict on identity (name, entry shape) and deliberately lenient on version, because
// rejecting an unrecognized app version would make the analyzer useless against the very logs most
// worth inspecting - those from a build that is ahead of it. Unknown versions analyze, with a
// warning attached, rather than being refused.
export function parseTapooLogExport(value: unknown): LogParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {ok: false, error: "Expected a Tapoo log export object at the top level."};
  }

  const envelope = value as Record<string, unknown>;

  if (envelope.name !== LOG_ENVELOPE_NAME) {
    return {
      ok: false,
      error: `Not a Tapoo log export: expected name "${LOG_ENVELOPE_NAME}", found ${JSON.stringify(envelope.name) ?? "nothing"}.`,
    };
  }

  if (!Array.isArray(envelope.entries)) {
    return {ok: false, error: "Tapoo log export is missing its `entries` array."};
  }

  const warnings: LogWarning[] = [];
  if (envelope.mode !== AGENT_API_MODE) {
    // Inaccurate rather than incomplete: every question is written for an agent-api round, so answering
    // them about some other mode produces verdicts, not correct ones.
    warnings.push({
      impact: "inaccurate",
      message: `Export mode is ${JSON.stringify(envelope.mode)}, not "${AGENT_API_MODE}". The behavior rubric only describes agent-api rounds.`,
    });
  }

  if (typeof envelope.version !== "string") {
    // Incomplete, not inaccurate: every verdict still stands, but the report cannot say which build
    // produced the behavior it describes, which is half of what makes it citable.
    warnings.push({
      impact: "incomplete",
      message: "Export carries no Tapoo version; results cannot be attributed to a build.",
    });
  }

  const entries = envelope.entries.filter(isLogEntry);
  const skipped = envelope.entries.length - entries.length;
  if (skipped > 0) {
    // Unreadable entries are stand-ins written by storage-logs.ts when a record fails to decode.
    // They are dropped rather than fatal: the surrounding round is still worth analyzing, but the
    // count has to surface, because it bounds how complete any "not observed" answer really is.
    warnings.push({
      // Inaccurate: the rubric answers NO on absent evidence, so evidence that was dropped rather than
      // never recorded can turn a YES into a NO without anything else looking wrong.
      impact: "inaccurate",
      message:
        skipped === 1
          ? "1 entry did not match the log entry shape and was skipped."
          : `${skipped} entries did not match the log entry shape and were skipped.`,
    });
  }

  if (entries.length === 0) {
    return {ok: false, error: "Tapoo log export contains no readable entries."};
  }

  // The same pass that validated the entries describes them: what the log contains, and where each
  // turn starts and ends. Every later reader indexes into this instead of walking the array again.
  const index = indexLog(entries);

  warnings.push(...encodedMazeWarnings(entries));

  // Neither unknownEvents nor levelDisagreements is reported here, deliberately.
  //
  // These warnings reach the reader under "Read with care", which is for caveats about the *log* - a
  // non-agent-api mode, a missing build version, entries that did not decode - things that genuinely
  // bound how much the verdicts are worth. An event the rubric has no question for is a gap in this
  // code, and a level contradicting its own payload is a bug in the producer. Neither is something a
  // reader can act on, and showing them there asks someone to distrust a report over an unimplemented
  // feature.
  //
  // The right home for "this event is not scored" is a fact question that scores it. Until there is
  // one, both stay available on the index for tests and for whoever adds that question - which is how
  // the two unscored events in a real glm-5.1 log were found in the first place.

  const log: TapooLog = {
    name: envelope.name,
    version: typeof envelope.version === "string" ? envelope.version : null,
    mode: typeof envelope.mode === "string" ? envelope.mode : null,
    downloadedAt: typeof envelope.downloadedAt === "string" ? envelope.downloadedAt : null,
    entries,
    index,
  };

  return {ok: true, value: log, warnings};
}

// parseTapooLogText is the raw JSON ingress point shared by the app and non-UI callers. Its successful
// output is the normalized Tapoo log shape every downstream query uses: name, version, mode,
// downloadedAt, and readable entries.
// encodedMazeWarnings validates the encoded maze each level-started entry should carry.
//
// This belongs with the rest of the contract validation rather than downstream in the view: whether a
// payload in this JSON is present and well-formed is the same question as whether the envelope has a
// mode or an entry has a payload, and it is answered once, here, on the way in.
//
// Validation is also what decides the impact, because it is what knows the difference:
//
//   absent  -> incomplete. The log never carried a maze. Nothing is wrong; a section is missing.
//   invalid -> inaccurate. A payload was provided and it is not what it claims to be - a structure
//              that fails its own checksum arrived damaged, and "damaged" is a statement about the
//              data's accuracy, not about how much of it there is.
//
// Either way the rubric verdicts stand: no question reads this payload. The corridor questions answer
// from the exits the log's own tool results confirmed.
function encodedMazeWarnings(entries: LogEntry[]): LogWarning[] {
  const warnings: LogWarning[] = [];

  for (const entry of entries) {
    if (entry.payload !== LOG_EVENTS.levelStarted) continue;

    const details = entry.details;
    const maze = details !== null && typeof details === "object" && "maze" in details
      ? details.maze
      : null;
    const round = `Game ${entry.game ?? "?"} level ${entry.level ?? "?"}`;
    const cost = "so it has no traversal replay and no maze statistics";

    if (maze === null || maze === undefined) {
      warnings.push({
        impact: "incomplete",
        message: `${round} carries no encoded maze, ${cost}.`,
      });
      continue;
    }

    const built = mazeFromEncoded(maze as EncodedMaze);
    if (!built.ok) {
      warnings.push({
        impact: "inaccurate",
        message: `${round} carries an encoded maze that did not decode, ${cost}. ${built.error}`,
      });
    }
  }

  return warnings;
}

export function parseTapooLogText(text: unknown, {sourceUrl}: {sourceUrl?: string} = {}): LogTextResult {
  const trimmed = asTrimmedText(text);
  if (!trimmed) {
    return {ok: false, error: "Load a Tapoo agent-api log from an online JSON URL to begin."};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`};
  }

  const result = parseTapooLogExport(parsed);
  if (!result.ok) {
    return {ok: false, error: result.error};
  }

  return {
    ok: true,
    source: sourceUrl ? {...result.value, sourceUrl} : result.value,
    warnings: result.warnings,
  };
}
