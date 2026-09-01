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
  CellKey,
  LogEntry,
  LogParseResult,
  LogTextResult,
  Move,
  TapooLog,
} from "./types";

import {asTrimmedText} from "./untrusted";

// --- Export identity ---

// LOG_CONTRACT_VERSION is the version of the *log shape*, not of Tapoo. It is independent of the
// APP_VERSION stamped into an export, because the log shape changes far less often than the app:
// tying consumers to the app version would reject logs on every unrelated patch release.
export const LOG_CONTRACT_VERSION = 1;

// LOG_ENVELOPE_NAME is the constant tapooDownloadLogs writes to the envelope's `name` field. It is
// what distinguishes a Tapoo log from any other JSON a user might paste into an analyzer.
export const LOG_ENVELOPE_NAME = "tapoo";

// AGENT_API_MODE is the only control mode that produces these logs. tapooDownloadLogs returns early
// for anything else, so an export naming a different mode did not come from an agent round.
export const AGENT_API_MODE = "agent-api";

// LOG_LEVELS mirrors the LogLevel union in frontend/app/types.ts.
export const LOG_LEVELS = new Set<string>(["error", "info", "warn"]);

// --- What a log says ---

// LOG_EVENTS is the payload sentence vocabulary the analyzer branches on. These strings are the
// stable identity of an event - the payload field is prose, but it is *fixed* prose, and matching it
// exactly is how an entry's meaning is recovered.
//
// Naming them here rather than inlining the literals is what makes a producer-side wording change a
// one-line fix instead of a silent behavioral drift spread across the analyzer, where a stale
// literal simply stops matching and quietly answers every dependent question "no".
export const LOG_EVENTS = {
  levelStarted: "Agent level started.",
  request: "Agent request.",
  response: "Agent response.",
  levelWon: "Agent level won.",
  levelLost: "Agent level lost.",
  duplicateToolWarningIgnored: "Agent kept re-requesting already-called tools after being told so.",
  hallucinatedTool: "Agent requested an unknown or hallucinated tool.",
  tokenCapExhausted: "Agent exhausted the token cap without returning a prediction.",
  providerHttpFailure: "Provider HTTP response failed.",
  requestFailed: "Request failed before a valid response.",
} as const;

// DECLARED_TOOLS are the context tools Tapoo declares to an agent. C3 asks one question per tool, in
// this order, so the order is part of the contract rather than an implementation detail.
export const DECLARED_TOOLS = [
  "get_maze_structure",
  "get_prediction_rules",
  "get_last_prediction_outcome",
] as const;

// --- Maze geometry ---

// MOVES maps each accepted move command to its [row, col] delta. The four keys are also the complete
// set of valid commands, which is what C1.Q3 checks against.
export const MOVES: Record<Move, readonly [number, number]> = {
  MoveUp: [-1, 0],
  MoveDown: [1, 0],
  MoveLeft: [0, -1],
  MoveRight: [0, 1],
};

// isMove narrows a string out of a log to a command the maze can actually apply.
//
// This guard is why stepFrom can take a Move rather than a string. A log's openMoves field is prose
// from a model's turn, so it can name anything; before, the one caller that did not check
// (availableContextDisregard) reached MOVES[move] with an unrecognized name, destructured undefined,
// and threw out of the whole report.
export const isMove = (value: unknown): value is Move =>
  typeof value === "string" && Object.hasOwn(MOVES, value);

// Cells are Map/Set keys, so they travel as "row,col" strings rather than arrays, which compare by
// identity and would make every lookup miss.
export const cellKey = (row: number, col: number): CellKey => `${row},${col}`;

// cellFromLogged reads either shape a logged cell arrives in.
//
// A downloaded log compacts every get_maze_structure result before writing it, turning {row, col}
// into [row, col]. Both shapes are real, so this is the one place that decides which is which -
// every field carrying a logged cell goes through here. Handling it per-caller is what previously
// produced "undefined,undefined" keys: one reader was taught the compact form and another, reading a
// different field, was not.
// The parameter is `unknown`, not LoggedCell: every caller reads this straight out of parsed JSON,
// where the value is whatever the producer wrote. Taking the narrow type would only move the cast to
// each call site - and a cast at a call site is a claim about untrusted data that nothing checked.
export function cellFromLogged(cell: unknown): CellKey | null {
  if (Array.isArray(cell)) {
    const [row, col] = cell as unknown[];
    return typeof row === "number" && typeof col === "number" ? cellKey(row, col) : null;
  }

  if (cell !== null && typeof cell === "object" && "row" in cell && "col" in cell) {
    const {row, col} = cell;
    return typeof row === "number" && typeof col === "number" ? cellKey(row, col) : null;
  }

  return null;
}

// movesFromLogged returns the move names a cell's exits allow, from either logged shape: the
// uncompacted object keyed by move name, or the compacted [move, visitStatus] pairs. Reading the
// compacted form with Object.keys yields array indices - "0", "1" - which match no move command, so
// every exit check silently failed.
// `unknown` for the same reason as cellFromLogged: the value comes straight from a parsed log.
export function movesFromLogged(openMoves: unknown): Set<string> {
  if (Array.isArray(openMoves)) {
    return new Set(
      (openMoves as unknown[])
        .map((entry) => (Array.isArray(entry) ? (entry as unknown[])[0] : entry))
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );
  }

  return new Set(Object.keys(openMoves ?? {}));
}

// stepFrom resolves the cell reached by applying one move command to a "row,col" key.
export function stepFrom(key: CellKey, move: Move): CellKey {
  const [row, col] = key.split(",").map(Number);
  const [rowDelta, colDelta] = MOVES[move];
  // A key that does not parse is a programming error, not log data: every key this receives was
  // built by cellKey.
  if (row === undefined || col === undefined || Number.isNaN(row) || Number.isNaN(col)) {
    throw new Error(`not a cell key: ${key}`);
  }

  return cellKey(row + rowDelta, col + colDelta);
}

// --- Traversal speed ---

// The thresholds from the rubric's Agent-Scoped Traversal Speed section. Reached through
// classifyTraversalSpeed rather than exported: the classification is the contract, not the table.
const TRAVERSAL_SPEED_CLASSES = {
  backtracker: "Backtracker",
  navigator: "Navigator",
  trailblazer: "Trailblazer",
} as const;

// classifyTraversalSpeed applies the rubric's three-way split. A non-positive or non-finite speed
// resolves to Backtracker rather than defaulting upward - the rubric is explicit that a missing
// denominator must never produce a Trailblazer result.
export function classifyTraversalSpeed(speed: unknown): string {
  const value = Number(speed);
  if (!Number.isFinite(value) || value < 1.0) {
    return TRAVERSAL_SPEED_CLASSES.backtracker;
  }

  return value > 1.0 ? TRAVERSAL_SPEED_CLASSES.trailblazer : TRAVERSAL_SPEED_CLASSES.navigator;
}

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

  const warnings: string[] = [];
  if (envelope.mode !== AGENT_API_MODE) {
    warnings.push(
      `Export mode is ${JSON.stringify(envelope.mode)}, not "${AGENT_API_MODE}". The behavior rubric only describes agent-api rounds.`,
    );
  }

  if (typeof envelope.version !== "string") {
    warnings.push("Export carries no Tapoo version; results cannot be attributed to a build.");
  }

  const entries = envelope.entries.filter(isLogEntry);
  const skipped = envelope.entries.length - entries.length;
  if (skipped > 0) {
    // Unreadable entries are stand-ins written by storage-logs.ts when a record fails to decode.
    // They are dropped rather than fatal: the surrounding round is still worth analyzing, but the
    // count has to surface, because it bounds how complete any "not observed" answer really is.
    warnings.push(
      skipped === 1
        ? "1 entry did not match the log entry shape and was skipped."
        : `${skipped} entries did not match the log entry shape and were skipped.`,
    );
  }

  if (entries.length === 0) {
    return {ok: false, error: "Tapoo log export contains no readable entries."};
  }

  const log: TapooLog = {
    name: envelope.name,
    version: typeof envelope.version === "string" ? envelope.version : null,
    mode: typeof envelope.mode === "string" ? envelope.mode : null,
    downloadedAt: typeof envelope.downloadedAt === "string" ? envelope.downloadedAt : null,
    entries,
  };

  return {ok: true, value: log, warnings};
}

// parseTapooLogText is the raw JSON ingress point shared by the app and non-UI callers. Its successful
// output is the normalized Tapoo log shape every downstream query uses: name, version, mode,
// downloadedAt, and readable entries.
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
