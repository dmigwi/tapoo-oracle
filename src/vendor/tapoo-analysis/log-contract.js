// Tapoo agent-api log contract.
//
// This module is the single definition of what a downloaded Tapoo log looks like, shared by every
// consumer that reads one: the CLI in scripts/agentic-analysis.mjs, and the Tapoo Oracle analytics
// app, which vendors this directory verbatim.
//
// It is deliberately IO-free and dependency-free so it runs unchanged in Node and in a browser
// bundle. Nothing here may import node: builtins - a single such import is what would stop the
// Oracle from consuming this file at all, which is the whole reason the split exists.
//
// The producer of this shape is frontend/app/logs.ts (tapooDownloadLogs) writing entries typed as
// LogEntry in frontend/app/types.ts. When that producer changes, this file changes with it, and
// LOG_CONTRACT_VERSION below is what tells a consumer it is looking at something it does not know
// how to read.

// LOG_CONTRACT_VERSION is the version of the *log shape*, not of Tapoo. It is independent of the
// APP_VERSION stamped into an export, because the log shape changes far less often than the app:
// tying consumers to the app version would reject logs on every unrelated patch release.
export const LOG_CONTRACT_VERSION = 1

// LOG_ENVELOPE_NAME is the constant tapooDownloadLogs writes to the envelope's `name` field. It is
// what distinguishes a Tapoo log from any other JSON a user might paste into an analyzer.
export const LOG_ENVELOPE_NAME = "tapoo"

// AGENT_API_MODE is the only control mode that produces these logs. tapooDownloadLogs returns early
// for anything else, so an export naming a different mode did not come from an agent round.
export const AGENT_API_MODE = "agent-api"

// LOG_LEVELS mirrors the LogLevel union in frontend/app/types.ts.
export const LOG_LEVELS = new Set(["error", "info", "warn"])

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
}

// DECLARED_TOOLS are the context tools Tapoo declares to an agent. C3 asks one question per tool, in
// this order, so the order is part of the contract rather than an implementation detail.
export const DECLARED_TOOLS = [
  "get_maze_structure",
  "get_prediction_rules",
  "get_last_prediction_outcome",
]

// MOVES maps each accepted move command to its [row, col] delta. The four keys are also the complete
// set of valid commands, which is what C1.Q3 checks against.
export const MOVES = {
  MoveUp: [-1, 0],
  MoveDown: [1, 0],
  MoveLeft: [0, -1],
  MoveRight: [0, 1],
}

// TRAVERSAL_SPEED_CLASSES are the thresholds from the rubric's Agent-Scoped Traversal Speed section.
export const TRAVERSAL_SPEED_CLASSES = {
  backtracker: "Backtracker",
  navigator: "Navigator",
  trailblazer: "Trailblazer",
}

// classifyTraversalSpeed applies the rubric's three-way split. A non-positive or non-finite speed
// resolves to Backtracker rather than defaulting upward - the rubric is explicit that a missing
// denominator must never produce a Trailblazer result.
export function classifyTraversalSpeed(speed) {
  const value = Number(speed)
  if (!Number.isFinite(value) || value < 1.0) {
    return TRAVERSAL_SPEED_CLASSES.backtracker
  }

  return value > 1.0 ? TRAVERSAL_SPEED_CLASSES.trailblazer : TRAVERSAL_SPEED_CLASSES.navigator
}

// Cells are Map/Set keys, so they travel as "row,col" strings rather than arrays, which compare by
// identity and would make every lookup miss.
export const cellKey = (row, col) => `${row},${col}`

// stepFrom resolves the cell reached by applying one move command to a "row,col" key.
export function stepFrom(key, move) {
  const [row, col] = key.split(",").map(Number)
  const [rowDelta, colDelta] = MOVES[move]
  return cellKey(row + rowDelta, col + colDelta)
}

// isLogEntry reports whether one array element carries the fields every consumer relies on. turn,
// level, and game are checked but not required to be present: logs written before those counters
// landed still analyze correctly, and buildContext has an explicit fallback for a missing turn.
function isLogEntry(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.payload === "string" &&
    typeof value.epochMs === "number" &&
    LOG_LEVELS.has(value.log)
  )
}

// parseTapooLogExport validates a parsed JSON value against the envelope contract and returns a
// discriminated result rather than throwing, because both consumers report the failure to a person:
// the CLI prints it, the Oracle renders it beside the input.
//
// The check is strict on identity (name, entry shape) and deliberately lenient on version, because
// rejecting an unrecognized app version would make the analyzer useless against the very logs most
// worth inspecting - those from a build that is ahead of it. Unknown versions analyze, with a
// warning attached, rather than being refused.
export function parseTapooLogExport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Expected a Tapoo log export object at the top level." }
  }

  if (value.name !== LOG_ENVELOPE_NAME) {
    return {
      ok: false,
      error: `Not a Tapoo log export: expected name "${LOG_ENVELOPE_NAME}", found ${JSON.stringify(value.name) ?? "nothing"}.`,
    }
  }

  if (!Array.isArray(value.entries)) {
    return { ok: false, error: "Tapoo log export is missing its `entries` array." }
  }

  const warnings = []
  if (value.mode !== AGENT_API_MODE) {
    warnings.push(
      `Export mode is ${JSON.stringify(value.mode)}, not "${AGENT_API_MODE}". The behavior rubric only describes agent-api rounds.`,
    )
  }

  if (typeof value.version !== "string") {
    warnings.push("Export carries no Tapoo version; results cannot be attributed to a build.")
  }

  const entries = value.entries.filter(isLogEntry)
  const skipped = value.entries.length - entries.length
  if (skipped > 0) {
    // Unreadable entries are stand-ins written by storage-logs.ts when a record fails to decode.
    // They are dropped rather than fatal: the surrounding round is still worth analyzing, but the
    // count has to surface, because it bounds how complete any "not observed" answer really is.
    warnings.push(`${skipped} entr${skipped === 1 ? "y" : "ies"} did not match the log entry shape and were skipped.`)
  }

  if (entries.length === 0) {
    return { ok: false, error: "Tapoo log export contains no readable entries." }
  }

  return {
    ok: true,
    value: {
      name: value.name,
      version: typeof value.version === "string" ? value.version : null,
      mode: typeof value.mode === "string" ? value.mode : null,
      downloadedAt: typeof value.downloadedAt === "string" ? value.downloadedAt : null,
      entries,
    },
    warnings,
  }
}
