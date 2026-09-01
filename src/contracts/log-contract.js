// Tapoo agent-api log contract.
//
// This module is the single definition of what a downloaded Tapoo log looks like, shared by every
// consumer that reads one: the CLI in scripts/agentic-analysis.mjs, and the Oracle analytics app in
// src/. There is exactly one copy, so the two front ends cannot answer the same log differently.
//
// It deliberately imports no dependencies and no node: builtins, so it runs unchanged in Node and in a
// browser bundle. The URL loader below accepts an injectable fetcher for tests and CLIs, but the
// contract validation itself stays pure.
//
// The producer of this shape is frontend/app/logs.ts (tapooDownloadLogs) writing entries typed as
// LogEntry in frontend/app/types.ts. When that producer changes, this file changes with it, and
// LOG_CONTRACT_VERSION below is what tells a consumer it is looking at something it does not know
// how to read.

// --- Export identity ---

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
}

// DECLARED_TOOLS are the context tools Tapoo declares to an agent. C3 asks one question per tool, in
// this order, so the order is part of the contract rather than an implementation detail.
export const DECLARED_TOOLS = [
  "get_maze_structure",
  "get_prediction_rules",
  "get_last_prediction_outcome",
]

// --- Maze geometry ---

// MOVES maps each accepted move command to its [row, col] delta. The four keys are also the complete
// set of valid commands, which is what C1.Q3 checks against.
export const MOVES = {
  MoveUp: [-1, 0],
  MoveDown: [1, 0],
  MoveLeft: [0, -1],
  MoveRight: [0, 1],
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

// --- Traversal speed ---

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

// --- Validating an export ---

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
    warnings.push(
      skipped === 1
        ? "1 entry did not match the log entry shape and was skipped."
        : `${skipped} entries did not match the log entry shape and were skipped.`,
    )
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

// parseTapooLogText is the raw JSON ingress point shared by the app and non-UI callers. Its successful
// output is the normalized Tapoo log shape every downstream query uses: name, version, mode,
// downloadedAt, and readable entries.
export function parseTapooLogText(text, {sourceUrl} = {}) {
  const trimmed = String(text ?? "").trim()
  if (!trimmed) {
    return {ok: false, error: "Load a Tapoo agent-api log from an online JSON URL to begin."}
  }

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return {ok: false, error: `Not valid JSON: ${error.message}`}
  }

  const result = parseTapooLogExport(parsed)
  if (!result.ok) {
    return {ok: false, error: result.error}
  }

  return {
    ok: true,
    source: sourceUrl ? {...result.value, sourceUrl} : result.value,
    warnings: result.warnings,
  }
}

// --- Online JSON URLs ---

export function validateOnlineJsonUrl(value) {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) {
    return {ok: false, error: "Enter an online JSON file URL."}
  }

  let url
  try {
    url = new URL(trimmed)
  } catch {
    return {ok: false, error: "Enter a valid URL."}
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return {ok: false, error: "Use an online http:// or https:// JSON URL."}
  }

  return {ok: true, url: url.href}
}

export async function fetchOnlineJsonText(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || "HTTP error"}`)
  }
  return response.text()
}

// fetchFailureMessage turns what fetch throws into something a reader can act on.
//
// A refused cross-origin request arrives as a bare TypeError with no status - the same shape as an
// offline browser - and "Failed to fetch" tells a reader nothing about which of the two it was. This is
// the one failure where a link that works for whoever shared it can fail for whoever opens it.
export function fetchFailureMessage(error) {
  const message = error?.message ?? String(error)
  if (error instanceof TypeError) {
    return `Could not reach the log: ${message}. The host may be offline, or may not allow other sites to read it.`
  }

  return `Could not load the log: ${message}. It may have been deleted, or may no longer be public.`
}

export async function loadTapooLogFromUrl(value, {fetchText = fetchOnlineJsonText} = {}) {
  const validation = validateOnlineJsonUrl(value)
  if (!validation.ok) {
    return validation
  }

  try {
    const text = await fetchText(validation.url)
    const result = parseTapooLogText(text, {sourceUrl: validation.url})
    return {...result, url: validation.url}
  } catch (error) {
    return {ok: false, error: fetchFailureMessage(error), url: validation.url}
  }
}

// --- Share payload format ---

// Prefixes worth dropping, longest match first. This is a compression table and never an allowlist:
// validateOnlineJsonUrl remains the only gate on what may be loaded, so a URL on any other host
// encodes and decodes exactly the same way - it just has less in common with the table and so
// compresses less. The two generic entries mean every http(s) URL matches something.
const REPORT_PAYLOAD_PREFIXES = [
  "https://gist.githubusercontent.com/",
  "https://raw.githubusercontent.com/",
  "https://",
  "http://",
]

// Marks a packed hex run inside the byte stream. 0x01 cannot occur in the text of a URL - control
// characters are percent-encoded by URL normalization long before they reach here - so no escaping is
// needed to tell a marker apart from content.
const REPORT_PAYLOAD_HEX_MARKER = 0x01

// Below this a run costs more in framing than it saves. 16 hex characters pack to 8 bytes plus 2 of
// framing; shorter runs are left as text.
const REPORT_PAYLOAD_HEX_MIN = 16

// Two trailing bytes over the rest of the token, so a link altered in transit is caught rather than
// decoded into a different, valid-looking address.
function reportPayloadIntegrityBytes(bytes) {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  const folded = ((hash >>> 16) ^ (hash & 0xffff)) & 0xffff
  return [folded >>> 8, folded & 0xff]
}

function base64UrlFromBytes(bytes) {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function bytesFromBase64Url(token) {
  const padded = token.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function isPackableHexSegment(segment) {
  return (
    segment.length >= REPORT_PAYLOAD_HEX_MIN &&
    segment.length % 2 === 0 &&
    /^[0-9a-f]+$/.test(segment)
  )
}

const LINK_UNNAMED = "This link does not name a report."

const LINK_ALTERED = "This link has been truncated, altered or damaged. Ask for a fresh link."

const elideToken = (token, head = 10, tail = 12) =>
  token.length <= head + tail + 3 ? token : `${token.slice(0, head)}...${token.slice(-tail)}`

const rejectedLink = (reason, token, linkLabel = (value) => `/r/${elideToken(value)}`) => ({
  ok: false,
  error: reason,
  link: token ? linkLabel(token) : null
})

export function encodeReportPayload(value) {
  const validation = validateOnlineJsonUrl(value)
  if (!validation.ok) {
    return validation
  }

  const index = REPORT_PAYLOAD_PREFIXES.findIndex((prefix) => validation.url.startsWith(prefix))
  const encoder = new TextEncoder()
  const bytes = [index]

  validation.url.slice(REPORT_PAYLOAD_PREFIXES[index].length).split("/").forEach((segment, position) => {
    if (position > 0) {
      bytes.push(...encoder.encode("/"))
    }

    if (!isPackableHexSegment(segment)) {
      bytes.push(...encoder.encode(segment))
      return
    }

    bytes.push(REPORT_PAYLOAD_HEX_MARKER, segment.length / 2)
    for (let at = 0; at < segment.length; at += 2) {
      bytes.push(Number.parseInt(segment.slice(at, at + 2), 16))
    }
  })

  return {ok: true, payload: base64UrlFromBytes(Uint8Array.from([...bytes, ...reportPayloadIntegrityBytes(bytes)]))}
}

export function decodeReportPayload(value, {linkLabel} = {}) {
  const token = String(value ?? "").trim()
  if (!token) {
    return rejectedLink(LINK_UNNAMED, "", linkLabel)
  }

  let framed
  try {
    framed = bytesFromBase64Url(token)
  } catch {
    return rejectedLink(LINK_ALTERED, token, linkLabel)
  }

  const bytes = framed.subarray(0, framed.length - 2)
  const [high, low] = reportPayloadIntegrityBytes(bytes)
  if (framed[framed.length - 2] !== high || framed[framed.length - 1] !== low) {
    return rejectedLink(LINK_ALTERED, token, linkLabel)
  }

  const prefix = REPORT_PAYLOAD_PREFIXES[bytes[0]]
  if (prefix === undefined) {
    return rejectedLink(LINK_ALTERED, token, linkLabel)
  }

  const decoder = new TextDecoder()
  let rest = ""
  let literalFrom = 1

  for (let at = 1; at < bytes.length; at += 1) {
    if (bytes[at] !== REPORT_PAYLOAD_HEX_MARKER) {
      continue
    }

    const count = bytes[at + 1]
    if (count === undefined || at + 2 + count > bytes.length) {
      return rejectedLink(LINK_ALTERED, token, linkLabel)
    }

    rest += decoder.decode(bytes.subarray(literalFrom, at))
    rest += [...bytes.subarray(at + 2, at + 2 + count)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    at += 1 + count
    literalFrom = at + 1
  }

  const address = rest + decoder.decode(bytes.subarray(literalFrom))
  if (!address) {
    return rejectedLink(LINK_ALTERED, token, linkLabel)
  }

  return validateOnlineJsonUrl(prefix + address)
}
