// Adapter between the rubric engine and this app's views.
//
// The analysis itself is not implemented here. It lives in src/analysis, which this app
// and the terminal front end (`make agentic-analysis`) both call, so the two cannot answer the same
// question about the same log differently. Everything below is presentation: turning one engine
// result into rows, cards, and sentences.
//
// The rule this file follows is that nothing it displays may be invented. Every number traces to a
// rubric answer or to an explicitly logged event - no substring sniffing, no guessed field names, no
// signal that the contract does not define. A plausible-looking number with no basis in the log is
// worse than an absent one, because it still reads as evidence.

import { cellKey, classifyTraversalSpeed, parseTapooLogExport } from "../analysis/log-contract.js";
import { mazeFromEncoded } from "../analysis/maze.js";
import { answerRubric } from "../analysis/rubric-engine.js";

// --- Analyzing a log ---

// analyzeLogText is the single entry point from raw text to a rendered result. It returns a
// discriminated result instead of throwing, because every failure here is a person's input mistake
// that the page has to explain, not an exceptional condition.
export function analyzeLogText(text, {label = "online log", sourceUrl} = {}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return {ok: false, error: "Load a Tapoo agent-api log from an online JSON URL to begin."};
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {ok: false, error: `Not valid JSON: ${error.message}`};
  }

  const result = parseTapooLogExport(parsed);
  if (!result.ok) {
    return {ok: false, error: result.error};
  }

  return {
    ok: true,
    source: sourceUrl ? {...result.value, sourceUrl} : result.value,
    warnings: result.warnings,
    report: answerRubric(result.value.entries, {label})
  };
}

// --- Online JSON URLs ---

export function validateOnlineJsonUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return {ok: false, error: "Enter an online JSON file URL."};
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return {ok: false, error: "Enter a valid URL."};
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return {ok: false, error: "Use an online http:// or https:// JSON URL."};
  }

  return {ok: true, url: url.href};
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
// characters are percent-encoded by URL normalization long before they reach here - so no escaping
// is needed to tell a marker apart from content.
const REPORT_PAYLOAD_HEX_MARKER = 0x01

// Below this a run costs more in framing than it saves. 16 hex characters pack to 8 bytes plus 2 of
// framing; shorter runs are left as text.
const REPORT_PAYLOAD_HEX_MIN = 16

// Two trailing bytes over the rest of the token, so a link altered in transit is caught rather than
// decoded into a different, valid-looking address.
//
// Without it, truncation is only caught when it lands inside a packed hex run: a cut that lands in
// the filename leaves a perfectly valid URL pointing at something that was never shared, and the
// reader is told the log could not be retrieved - the wrong remedy for a broken link. Two bytes are
// free here in practice, since base64 rounds to groups of three.
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

// Packable only when the whole segment is lowercase hex of even length: an odd length cannot be
// halved into bytes, and uppercase would not survive the round trip byte-for-byte.
function isPackableHexSegment(segment) {
  return (
    segment.length >= REPORT_PAYLOAD_HEX_MIN &&
    segment.length % 2 === 0 &&
    /^[0-9a-f]+$/.test(segment)
  )
}

// --- Report routes and links ---

// The route a shared report lives at. Namespaced under /r/ rather than sitting at the root so it
// reads as a route, and so a future host with real routing can serve it without having to guess
// whether a path segment is a token or a page.
const REPORT_ROUTE = "r"

const REPORT_ROUTE_PATTERN = new RegExp(`/${REPORT_ROUTE}/([A-Za-z0-9_-]+)/?$`)

// The fragment hop carries the same marker the path form does.
//
// A bare #<token> cannot be told apart from an ordinary page anchor: base64url tokens use the same
// characters a slug does, so #section-two and a real token are the same shape. The path form never had
// this problem because the literal /r/ segment marks it, and this restores that symmetry. Everything
// after the marker is captured, damaged or not, so a mangled token still reaches decodeReportPayload
// and is reported as a damaged link rather than silently ignored.
const REPORT_PAYLOAD_FRAGMENT_PATTERN = new RegExp(`^#?${REPORT_ROUTE}=(.+)$`)

// appBasePath finds where the app is served from, given any page within it.
//
// It has to strip a report route back off, because the address bar of a shared report already
// carries one - composing a new link from that pathname would otherwise nest /r/ inside /r/. It also
// drops a trailing file name so /index.html and / produce the same base.
export function appBasePath(pathname = "/") {
  const withoutRoute = String(pathname).replace(REPORT_ROUTE_PATTERN, "/")
  const withoutFile = withoutRoute.replace(/[^/]*\.html?$/, "")
  return withoutFile.endsWith("/") ? withoutFile : `${withoutFile}/`
}

// reportRouteFor composes the public form of a link from a token. Every address the reader is left
// looking at goes through here, so the route is built one way only.
function reportRouteFor(token, location = globalThis.location) {
  return `${location.origin}${appBasePath(location.pathname)}${REPORT_ROUTE}/${token}`
}

// appRootFor is where a reader is left when no token can be shown - never the fragment, which is an
// internal hop and not an address anyone should be handed.
function appRootFor(location = globalThis.location) {
  return `${location.origin}${appBasePath(location.pathname)}`
}

// shareLinkFor composes the link that reproduces one report.
//
// The token is a path segment, which means it is sent to the host: GitHub Pages will have the
// (recoverable) log address in its request logs, and every shared link is served with a 404 status
// through the shim in 404.md. That trade was made deliberately for a link that reads as a link.
export function shareLinkFor(url, location = globalThis.location) {
  const encoded = encodeReportPayload(url)
  if (!encoded.ok) {
    return null
  }

  return reportRouteFor(encoded.payload, location)
}

// reportPayloadFromPath reads the token out of a /r/<token> route.
export function reportPayloadFromPath(pathname) {
  return REPORT_ROUTE_PATTERN.exec(String(pathname ?? ""))?.[1] ?? null
}

// reportPayloadFromHash reads a token out of a location fragment.
//
// Not the shape anyone is given: it is how 404.md hands the token to the app, since a static host
// cannot serve the app at an arbitrary path without a redirect. Kept separate from the route reader
// so the public form and the internal hop can change independently.
export function reportPayloadFromHash(hash) {
  return REPORT_PAYLOAD_FRAGMENT_PATTERN.exec(String(hash ?? ""))?.[1] ?? null
}

// --- Why a link failed ---

// Two outcomes, because a reader has exactly two situations to be in: either the link named no report
// at all, or it named one and did not survive the trip. Every way a token can fail past that point -
// characters that were never base64url, a run that overshoots the token, a checksum that no longer
// matches, a prefix this build does not know - is the same event to the person holding it, and the
// same remedy. Splitting them further only asks the reader to care which byte went wrong.
const LINK_UNNAMED = "This link does not name a report."

const LINK_ALTERED = "This link has been truncated, altered or damaged. Ask for a fresh link."

// elideToken keeps both ends of an opaque token. The head is what a reader matches at a glance against
// the link they were sent; the tail is where truncation and transcription damage actually shows up. A
// tail alone reads as random text, which is the one thing this label must not do.
const elideToken = (token, head = 10, tail = 12) =>
  token.length <= head + tail + 3 ? token : `${token.slice(0, head)}...${token.slice(-tail)}`

// damagedLinkLabel shows the failure in the shape the reader was actually handed - origin, base path,
// /r/, then the elided token. The scheme and host are what make it recognizable as a URL at a glance
// rather than a string of characters. Off a browser there is no origin to name, so it degrades to the
// route path, which still reads as a link.
const damagedLinkLabel = (token) => {
  const elided = elideToken(token)
  const location = globalThis.location
  return location?.origin ? reportRouteFor(elided, location) : `/${REPORT_ROUTE}/${elided}`
}

// rejectedLink pairs a reason with the link it is about, kept as separate values rather than joined
// into one sentence: the view marks the link up as code, which it cannot do once the two are one
// string. An unnamed token - the empty case - carries no link, since there is nothing to point at.
//
// The link belongs in the message and never in the address bar: the token is opaque and this one does
// not decode, so a /r/<token> address built from it would resolve to nothing while still looking usable.
const rejectedLink = (reason, token) => ({
  ok: false,
  error: reason,
  link: token ? damagedLinkLabel(token) : null
})

// --- Encoding and decoding a link ---

// encodeReportPayload turns a log URL into the token a shared link carries.
//
// Recoverable by design - this compacts and obscures, it does not conceal, and nothing shown to a
// reader should suggest otherwise. What it buys is that the log address is no longer sitting in the
// page as a URL to be read, copied or crawled out of a screenshot.
//
// Two savings, in order: the prefix, and any long hex run. A content-addressed URL spends most of
// its length on hex that is really half as many bytes - the sample gist URL carries a 32-character
// id and a 40-character revision - and base64 costs 33%, so dropping the prefix alone would produce
// a token longer than the URL it replaced.
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

// decodeReportPayload reverses it, answering in the same shape validateOnlineJsonUrl uses so callers
// handle one result type.
//
// The rebuilt URL is passed back through validateOnlineJsonUrl rather than trusted: a token arrives
// from whatever pasted the link, and a hand-edited one must not be able to produce something the
// loader would have refused had it been typed into the form.
export function decodeReportPayload(value) {
  const token = String(value ?? "").trim()
  if (!token) {
    return rejectedLink(LINK_UNNAMED, "")
  }

  let framed
  try {
    framed = bytesFromBase64Url(token)
  } catch {
    return rejectedLink(LINK_ALTERED, token)
  }

  const bytes = framed.subarray(0, framed.length - 2)
  const [high, low] = reportPayloadIntegrityBytes(bytes)
  if (framed[framed.length - 2] !== high || framed[framed.length - 1] !== low) {
    return rejectedLink(LINK_ALTERED, token)
  }

  const prefix = REPORT_PAYLOAD_PREFIXES[bytes[0]]
  if (prefix === undefined) {
    return rejectedLink(LINK_ALTERED, token)
  }

  const decoder = new TextDecoder()
  let rest = ""
  let literalFrom = 1

  for (let at = 1; at < bytes.length; at += 1) {
    if (bytes[at] !== REPORT_PAYLOAD_HEX_MARKER) {
      continue
    }

    const count = bytes[at + 1]
    // A run claiming more bytes than the token holds is a truncated link, not a shorter URL.
    if (count === undefined || at + 2 + count > bytes.length) {
      return rejectedLink(LINK_ALTERED, token)
    }

    rest += decoder.decode(bytes.subarray(literalFrom, at))
    rest += [...bytes.subarray(at + 2, at + 2 + count)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    at += 1 + count
    literalFrom = at + 1
  }

  // A token has to carry an address beyond its prefix. This replaces a "framed.length < 4" byte-count
  // check that approximated the same thing: without either, a four-character token decodes to a bare
  // "https://gist.githubusercontent.com/" - no path, no file - which is a syntactically valid URL, so
  // it passes validation and the app goes and fetches a host root. Saying it in terms of the address
  // states the rule the byte count was standing in for.
  const address = rest + decoder.decode(bytes.subarray(literalFrom))
  if (!address) {
    return rejectedLink(LINK_ALTERED, token)
  }

  return validateOnlineJsonUrl(prefix + address)
}

// --- Report tabs ---

function reportTabId() {
  if (globalThis.crypto?.randomUUID) {
    return `report-${globalThis.crypto.randomUUID()}`;
  }
  return `report-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function reportTabLabelFromUrl(value, index = 0) {
  const fallback = `Report ${index + 1}`;
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
    return trimReportTabLabel(name || url.hostname || fallback);
  } catch {
    return fallback;
  }
}

export function trimReportTabLabel(value, maxLength = 34) {
  const label = String(value ?? "").trim();
  if (label.length <= maxLength) return label;
  return `...${label.slice(-(maxLength - 3))}`;
}

export function createEmptyReportTab(id = reportTabId()) {
  return {
    id,
    url: "",
    label: "New report",
    status: "empty",
  };
}

export function createInitialReportTabs() {
  return {
    tabs: [],
    activeTabId: null,
    isAdding: true,
    draftUrl: "",
    draftStatus: "empty",
  };
}

export function addReportTab(state, id = reportTabId()) {
  return {
    ...state,
    pendingTabId: id,
    isAdding: true,
    draftUrl: "",
    draftStatus: "empty",
    draftError: undefined,
  };
}

export function updateReportTab(state, tabId, patch) {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? {...tab, ...patch} : tab)),
  };
}

export function deleteReportTab(state, tabId, createId = reportTabId) {
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
  return {tabs, activeTabId: tabs[nextIndex].id};
}

// --- Loading a report ---

async function fetchReportText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || "HTTP error"}`);
  }
  return response.text();
}

// describeFetchFailure turns what fetch throws into something a reader can act on.
//
// A refused cross-origin request arrives as a bare TypeError with no status - the same shape as an
// offline browser - and "Failed to fetch" tells a reader nothing about which of the two it was. This
// is the one failure where a link that works for whoever shared it can fail for whoever opens it.
export function describeFetchFailure(error) {
  const message = error?.message ?? String(error)
  if (error instanceof TypeError) {
    return `Could not reach the log: ${message}. The host may be offline, or may not allow other sites to read it.`
  }

  return `Could not load the log: ${message}. It may have been deleted, or may no longer be public.`
}

export async function loadNewReportTabFromUrl(state, fetchText = fetchReportText) {
  const tabId = state.pendingTabId ?? reportTabId();
  const validation = validateOnlineJsonUrl(state.draftUrl);
  if (!validation.ok) {
    return {
      ...state,
      isAdding: true,
      draftStatus: "error",
      draftError: validation.error,
    };
  }

  const label = reportTabLabelFromUrl(validation.url, state.tabs.length);
  const baseTab = {
    id: tabId,
    url: validation.url,
    label,
    loadedUrl: validation.url,
  };

  try {
    const text = await fetchText(validation.url);
    const result = analyzeLogText(text, {label, sourceUrl: validation.url});
    const tab = result.ok
      ? {...baseTab, status: "loaded", result, error: undefined}
      : {...baseTab, status: "error", result, error: result.error};
    return {
      ...state,
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      isAdding: false,
      draftUrl: "",
      draftStatus: "empty",
      draftError: undefined,
      pendingTabId: undefined,
    };
  } catch (error) {
    const tab = {
      ...baseTab,
      status: "error",
      error: describeFetchFailure(error),
      result: undefined,
    };
    return {
      ...state,
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
      isAdding: false,
      draftUrl: "",
      draftStatus: "empty",
      draftError: undefined,
      pendingTabId: undefined,
    };
  }
}

export async function loadReportTabFromUrl(state, tabId, fetchText = fetchReportText) {
  const tab = state.tabs.find((candidate) => candidate.id === tabId);
  const validation = validateOnlineJsonUrl(tab?.url);
  if (!validation.ok) {
    return updateReportTab(state, tabId, {
      status: "error",
      error: validation.error,
      result: undefined,
      loadedUrl: undefined,
    });
  }

  const label = reportTabLabelFromUrl(validation.url, state.tabs.findIndex((candidate) => candidate.id === tabId));
  try {
    const text = await fetchText(validation.url);
    const result = analyzeLogText(text, {label, sourceUrl: validation.url});
    return updateReportTab(state, tabId, result.ok
      ? {status: "loaded", label, result, loadedUrl: validation.url, error: undefined}
      : {status: "error", label, result, loadedUrl: validation.url, error: result.error});
  } catch (error) {
    return updateReportTab(state, tabId, {
      status: "error",
      label,
      error: describeFetchFailure(error),
      result: undefined,
      loadedUrl: validation.url,
    });
  }
}

// --- Report adapters ---

function formatCount(value) {
  return Number(value).toLocaleString("en-US");
}

export function profileCards(report) {
  const met = (groups) => groups.filter((group) => group.met).length;

  return [
    {
      label: "Capabilities demonstrated",
      value: `${met(report.capabilities)}/${report.capabilities.length}`,
      tone: "teal"
    },
    {
      label: "Violations confirmed",
      value: `${met(report.violations)}/${report.violations.length}`,
      tone: "rose"
    },
    {label: "Predictions", value: formatCount(report.predictions), tone: "ink"},
    {label: "Rounds", value: formatCount(report.rounds), tone: "ink"}
  ];
}

// narrativeSummary states the profile in a sentence, and says plainly what a "no" means. Readers
// reliably over-read a negative rubric answer as a claim about the model's ability, which it never
// is - it says the behavior was not observed in this one sample.
export function narrativeSummary(report) {
  const capabilities = report.capabilities.filter((group) => group.met).map((group) => group.id);
  const violations = report.violations.filter((group) => group.met).map((group) => group.id);
  const speed = report.traversalSpeedClass
    ? `Winning traversal speed ${report.traversalSpeed.toFixed(4)} (${report.traversalSpeedClass}).`
    : "No winning round in this sample.";

  return [
    `${report.model ?? "This agent"} demonstrated ${capabilities.length} of ${report.capabilities.length} capabilities`,
    capabilities.length ? `(${capabilities.join(", ")})` : "",
    `across ${formatCount(report.predictions)} prediction${report.predictions === 1 ? "" : "s"}.`,
    violations.length
      ? `Confirmed violations: ${violations.join(", ")}.`
      : "No violations confirmed.",
    speed,
    "A negative answer means the behavior was not observed in this sample, not that the model is incapable of it."
  ]
    .filter(Boolean)
    .join(" ");
}

// groupResultTone names the class a group result should carry, or null for no colour at all.
//
// Split out from the table's format callback because this is the part that can be wrong: YES means
// opposite things in the two tables, and the rule for what stays uncoloured is a statement about
// what the rubric claims. The span-wrapping around it cannot be, so the DOM stays in the view and
// the decision stays here where the suite can reach it.
export function groupResultTone(kind, groupResult) {
  // NO is never coloured. For a violation it is the good outcome, and for a capability it means the
  // behavior was not observed in this sample - never that the model is incapable of it, which is the
  // one thing this report exists not to say. Red on that line would say it.
  if (!String(groupResult).startsWith("YES")) {
    return null
  }

  return kind === "violation" ? "result-confirmed" : "result-demonstrated"
}

// rubricQuestionRows gives every evaluated fact its own row. Group verdicts and fractions remain
// visible because a partially evidenced group and a group with no evidence can share the same NO.
export function rubricQuestionRows(groups) {
  return groups.flatMap((group) =>
    Object.entries(group.answers).map(([questionId, answer]) => ({
      id: `${group.id}.${questionId}`,
      group: group.label,
      question: group.questions[questionId],
      answer: answer ? "YES" : "NO",
      groupResult: `${group.met ? "YES" : "NO"} (${group.passed}/${group.total})`,
    })),
  )
}

// diagnosticRows reports operational signals that are deliberately excluded from the violation
// profile. Endpoint failures in particular can be caused by infrastructure outside the model's
// reasoning, so the rubric notes require them to be preserved as evidence but never scored.
export function diagnosticRows(report) {
  return [
    {signal: "Endpoint failures", count: report.diagnostics.endpointFailures, scored: "no"},
    {signal: "Empty responses", count: report.diagnostics.emptyResponses, scored: "V2.Q2"},
    {signal: "Unparseable responses", count: report.diagnostics.unparseableResponses, scored: "V2.Q1"},
    {signal: "Token cap exhaustions", count: report.diagnostics.tokenExhaustions, scored: "V5.Q3"}
  ];
}

// diagnosticTableData pivots the short diagnostic list into a wide comparison matrix. Keeping the
// two measures as rows avoids packing count and scoring semantics into an ambiguous combined value.
export function diagnosticTableData(report) {
  const diagnostics = diagnosticRows(report)
  const columns = ["measure", ...diagnostics.map((row) => row.signal)]

  return {
    columns,
    rows: [
      Object.fromEntries([["measure", "Count"], ...diagnostics.map((row) => [row.signal, row.count])]),
      Object.fromEntries([["measure", "Scored as"], ...diagnostics.map((row) => [row.signal, row.scored])]),
    ],
  }
}

// provenanceRows describe which build and which round produced the log, so a profile is never read
// detached from what it was measured against.
export function provenanceRows(source, report) {
  return [
    // No source URL row. It is the one field here that is not read out of the log itself, the panel
    // above already carries the share link that identifies the same log, and a table cell is the
    // most screenshotted place on the page to put an address that the rest of this change exists to
    // keep out of it. What remains is provenance the log vouches for.
    {field: "Tapoo version", value: source.version ?? "not recorded"},
    {field: "Control mode", value: source.mode ?? "not recorded"},
    {field: "Downloaded at", value: source.downloadedAt ?? "not recorded"},
    {field: "Log entries", value: formatCount(source.entries.length)},
    {field: "Model", value: report.model ?? "not recorded"},
    {field: "Player", value: report.player ?? "not recorded"}
  ];
}

// provenanceTableData renders the small provenance record as one horizontal row so a wide report
// does not spend six rows on six short values.
export function provenanceTableData(source, report) {
  const provenance = provenanceRows(source, report)
  return {
    columns: provenance.map((row) => row.field),
    rows: [Object.fromEntries(provenance.map((row) => [row.field, row.value]))],
  }
}

// --- Maze replay adapters ---

// mazeReplayModel turns each played round into everything the maze view needs, or the reason it cannot
// be drawn.
//
// The maze is not optional context: a traversal drawn on a grid that failed its checksum would be a
// picture of damaged bytes presented as evidence. So a round that cannot be decoded carries an error
// instead of a partial grid, and the view renders the error.
export function mazeReplayModel(report) {
  const levels = report?.levels ?? [];

  return levels.map((level) => {
    const destination = level.destinationCell
      ? cellKey(level.destinationCell.row, level.destinationCell.col)
      : null;
    const built = mazeFromEncoded(level.encodedMaze, {
      startCell: level.startCell,
      destinationCell: destination
    });

    // Colour is assigned per player in first-acting order, so a seat keeps the same colour across every
    // level of a log rather than changing when another seat happens to move first.
    const agents = [];
    for (const turn of level.turns) {
      if (turn.playerName && !agents.includes(turn.playerName)) agents.push(turn.playerName);
    }

    return {
      key: level.key,
      game: level.game,
      level: level.level,
      label: `Level ${level.level}${levels.length > 1 ? ` (game ${level.game})` : ""}`,
      maze: built.ok ? built.maze : null,
      error: built.ok ? null : built.error,
      stats: built.ok ? built.stats : null,
      startCell: level.startCell,
      destinationCell: destination,
      endCell: level.endCell,
      observedExits: level.observedExits,
      turns: level.turns,
      outcome: level.outcome,
      agents
    };
  });
}

// mazeFrameAt reports the state of the replay after `turnIndex` turns have been played.
//
// Pure, and the only thing the scrubber calls: keeping the frame a value rather than mutating the view
// means every position it can show is reachable in a test without a browser.
export function mazeFrameAt(levelModel, turnIndex) {
  const played = levelModel.turns.slice(0, Math.max(0, Math.min(turnIndex, levelModel.turns.length)));
  const visited = new Map();

  if (levelModel.startCell) visited.set(levelModel.startCell, null);
  for (const turn of played) {
    for (const cell of turn.cells) visited.set(cell, turn.playerName);
  }

  const current = played.at(-1);
  const positions = new Map();
  for (const turn of played) {
    if (turn.playerName && turn.cells.length > 0) positions.set(turn.playerName, turn.cells.at(-1));
  }

  return {
    turnIndex: played.length,
    totalTurns: levelModel.turns.length,
    visited,
    positions,
    currentCell: current?.cells.at(-1) ?? levelModel.startCell ?? null,
    // The wall the agent walked into on this turn, if any. Drawn only for the current turn: a rejected
    // move is an event, not a lasting property of the cell.
    rejected: current?.rejectedMove ? {cell: current.cells.at(-1), move: current.rejectedMove} : null,
    turn: current ?? null
  };
}

// mazeSummaryRows describes the maze itself and how much of it the round actually used.
export function mazeSummaryRows(levelModel) {
  if (!levelModel?.stats) return [];

  const stats = levelModel.stats;
  const walked = new Set(levelModel.turns.flatMap((turn) => turn.cells));
  if (levelModel.startCell) walked.add(levelModel.startCell);
  const outcome = levelModel.outcome ?? {};
  const agentCells = Number(outcome.playerUniqueCellsVisited);
  const coverage = stats.cells > 0 ? Math.round((walked.size / stats.cells) * 100) : 0;

  return [
    {field: "Maze size", value: `${stats.rows} x ${stats.cols} (${formatCount(stats.cells)} cells)`},
    {field: "Dead ends", value: formatCount(stats.deadEnds)},
    {field: "Corridors", value: formatCount(stats.corridors)},
    {field: "Junctions", value: formatCount(stats.junctions)},
    {
      field: "Shortest route",
      value: stats.shortestPath === null ? "no route found" : `${formatCount(stats.shortestPath)} moves`
    },
    {field: "Cells entered", value: `${formatCount(walked.size)} of ${formatCount(stats.cells)} (${coverage}%)`},
    {
      // Tapoo credits the start cell to the "Self" pseudo-player, so an agent's own unique-cell count is
      // one below the cells its path covers. Reporting both stops that gap reading as an error.
      field: "Credited to agent",
      value: Number.isFinite(agentCells) ? formatCount(agentCells) : "not recorded"
    },
    {
      field: "Decay charged",
      value: Number.isFinite(Number(outcome.decayUnitsCharged))
        ? formatCount(outcome.decayUnitsCharged)
        : "not recorded"
    }
  ];
}

// levelSummaryRows gives one row per played round, so a multi-level log reads as a sequence rather than
// a single aggregate.
export function levelSummaryRows(report) {
  return (report?.levels ?? []).map((level) => {
    const outcome = level.outcome ?? {};
    const speed = Number(outcome.traversalSpeed);

    return {
      level: level.level ?? "-",
      game: level.game ?? "-",
      outcome: outcome.outcome ?? "unfinished",
      turns: level.turns.length,
      // Classified here rather than read from the log: the log's own class field is lower-cased, and two
      // spellings of the same class in one report read as two different things.
      speed: Number.isFinite(speed) ? speed.toFixed(4) : "not recorded",
      class: Number.isFinite(speed) ? classifyTraversalSpeed(speed) : "not recorded"
    };
  });
}

// --- Table post-processing ---

// profileCards summarizes a report as headline counts.
//
// Capabilities and violations are reported as separate fractions and never combined. The rubric is
// explicit that they must not collapse into one score interval: a model with six capabilities and
// two violations is not "four", and any arithmetic that produces a single number here would be
// inventing a scale the contract deliberately refuses to define.
// Column classes, keyed by header text. Positional selectors cannot address these columns: rows
// after a group's first lose two cells to the merge below, so nth-last-child(4) is the group name on
// one row and the leading spacer on the next. A class travels with the cell.
const RUBRIC_COLUMN_CLASSES = {
  "ID": "rubric-id",
  "Group": "rubric-group",
  "Fact question": "rubric-question",
  "Answer": "rubric-answer",
  "Group result": "rubric-result",
}

// prepareRubricTable labels each column and merges each group's repeated cells into one cell
// spanning its questions.
//
// A group answers one verdict from several fact questions, and Inputs.table can only render flat
// rows - so C1's three rows each repeated "INSTRUCTION ADHERENCE" and "YES (3/3)". Reading down the
// column, that looks like three separate verdicts that happen to agree, which is the opposite of
// what the rubric says: there is one verdict per group, and the questions are its evidence. Spanning
// the cell states that in the table's own structure.
//
// Safe as a one-time pass because these tables are built with sort disabled and every row
// materialized, so the body is never re-ordered or extended underneath it.
export function prepareRubricTable(node) {
  const table = node.querySelector("table")
  const body = table?.querySelector("tbody")
  if (!body) {
    return node
  }

  // Located by header text rather than by a fixed index: Inputs.table emits a leading spacer cell,
  // and a hard-coded position silently points one column off the moment that changes.
  const headers = [...(table.querySelector("thead tr")?.cells ?? [])]

  // Labelled before anything is merged, while every row still has every cell in the same position.
  headers.forEach((header, index) => {
    const columnClass = RUBRIC_COLUMN_CLASSES[header.textContent.trim()]
    if (!columnClass) {
      return
    }

    header.classList.add(columnClass)
    for (const row of body.rows) {
      row.cells[index]?.classList.add(columnClass)
    }
  })

  const columns = ["Group", "Group result"]
    .map((label) => headers.findIndex((cell) => cell.textContent.trim() === label))
    .filter((index) => index >= 0)
  if (columns.length === 0) {
    return node
  }

  const groupOf = (row) => row.cells[columns[0]]?.textContent.trim()
  let anchor = null
  let span = 0

  const closeRun = () => {
    if (anchor && span > 1) {
      for (const index of columns) {
        anchor.cells[index].rowSpan = span
      }
    }
  }

  for (const row of [...body.rows]) {
    if (anchor && groupOf(row) === groupOf(anchor)) {
      span += 1
      // Removed last-to-first so each removal cannot shift an index still to be used.
      for (const index of [...columns].reverse()) {
        row.cells[index].remove()
      }
      continue
    }

    closeRun()
    anchor = row
    span = 1
  }

  closeRun()
  return node
}

// enableRowSelection makes the whole row a click target for its own checkbox. The checkbox is a
// 13px square at the far left of a row whose content runs the width of the page, so hitting it means
// aiming at the one part of the row that is hardest to hit - and on a touch screen it is below the
// recommended target size outright.
//
// Delegated on the table rather than bound per row, so it survives Inputs.table re-rendering its
// body, and it dispatches input *and* change: Inputs.table reads its value from input events, and
// the CSS that tints the row keys off :checked, so a silent .checked assignment would move the tint
// without moving the input's value.
export function enableRowSelection(node) {
  const table = node.querySelector("table")
  if (!table) {
    return node
  }

  table.addEventListener("click", (event) => {
    // The control itself already toggles; handling it here as well would toggle twice and land back
    // where it started. Links and buttons inside a cell keep their own behavior.
    if (event.target.closest("input, a, button, label")) {
      return
    }

    // A click that ends a text selection is someone copying a fact question, not choosing a row.
    if (window.getSelection()?.toString()) {
      return
    }

    const checkbox = event.target.closest("tbody tr")?.querySelector("input[type=checkbox]")
    if (!checkbox) {
      return
    }

    // Forward the click to the checkbox rather than setting .checked and announcing it. Inputs.table
    // wires every row checkbox with `input.onclick = reselect`, and that handler owns the selection
    // set, the header checkbox's checked/indeterminate state, and the table's own value. Assigning
    // .checked moves the tick and the :checked tint while none of that bookkeeping runs - the row
    // looks selected, the header stays blank, and the value the table reports omits the row. A click
    // dispatched on a checkbox performs its activation behavior, so the toggle is still native.
    //
    // shiftKey and detail are carried over so a shift-click on a row extends the range exactly as a
    // shift-click on the checkbox does, and so reselect's blur-on-real-click still fires.
    checkbox.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      shiftKey: event.shiftKey,
      detail: event.detail,
    }))
  })

  return node
}

// --- The report tabs control ---

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
function createShareControl(url) {
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

  button.addEventListener("click", async () => {
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
  })

  return button
}

export function createReportTabsInput({fetchText = fetchReportText} = {}) {
  let state = createInitialReportTabs();
  const root = document.createElement("section");
  root.className = "report-workspace";
  Object.defineProperty(root, "value", {
    get: () => state,
  });

  const emit = () => {
    root.dispatchEvent(new Event("input", {bubbles: true}));
    render();
  };

  const setState = (nextState) => {
    state = nextState;
    emit();
  };

  const loadNewTab = async () => {
    const requestedUrl = state.draftUrl;
    setState({...state, draftStatus: "loading", draftError: undefined});
    const loadedState = await loadNewReportTabFromUrl(state, fetchText);
    if (state.draftUrl !== requestedUrl) return;
    setState(loadedState);
    rememberActiveReport(loadedState);
  };

  // Keeps the address bar carrying the active report, so a reload or a bookmark reopens what is on
  // screen. replaceState rather than assigning location.hash: assigning pushes an entry, and loading
  // three reports would otherwise mean three presses of Back to leave the page.
  const rememberActiveReport = (nextState) => {
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
  };

  // Opens the report a shared link names, with no input from the reader.
  //
  // Routed through the same loadNewReportTabFromUrl the form uses, so the fetch, the log-contract
  // validation, the warnings and every error path are the ones already covered - a second loader for
  // shared links would be a second place for them to diverge.
  const restoreSharedReport = async () => {
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
        ...state,
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
      ...state,
      isAdding: false,
      sharedLinkLoading: true,
      sharedLinkError: undefined,
      sharedLinkBroken: undefined
    });
    const loadedState = await loadNewReportTabFromUrl({...state, draftUrl: decoded.url}, fetchText);
    setState({...loadedState, draftUrl: "", sharedLinkLoading: false});
    // Puts /r/<token> back in the address bar. The fragment is an implementation detail of the hop
    // through 404.md, and leaving it on screen would mean the link someone opened is not the link
    // they could copy back out - or bookmark, or send on.
    rememberActiveReport(loadedState);
  };

  const render = () => {
    root.replaceChildren();
    const navigator = document.createElement("section");
    navigator.className = "report-navigator";
    navigator.setAttribute("aria-label", "Loaded reports");

    const add = document.createElement("button");
    add.type = "button";
    add.className = "report-add";
    add.textContent = "+ Add Report";
    add.addEventListener("click", () => setState(addReportTab(state)));
    navigator.append(add);

    const nav = document.createElement("div");
    nav.className = "report-list";
    nav.setAttribute("role", "tablist");

    for (const tab of state.tabs) {
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
        const nextState = {...state, activeTabId: tab.id, isAdding: false};
        setState(nextState);
        // The address bar names the active report, so switching which one is active has to move it
        // too - otherwise the link on screen belongs to a tab the reader has left.
        rememberActiveReport(nextState);
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "report-delete";
      remove.setAttribute("aria-label", `Delete ${tab.label}`);
      remove.textContent = "x";
      remove.addEventListener("click", () => {
        const nextState = deleteReportTab(state, tab.id);
        setState(nextState);
        rememberActiveReport(nextState);
      });

      item.append(button, remove);
      nav.append(item);
    }

    navigator.append(nav);

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

      root.append(navigator, content);
      return;
    }

    if (!state.isAdding) {
      root.append(navigator, content);
      return;
    }

    const form = document.createElement("form");
    form.className = "report-url-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void loadNewTab();
    });

    const label = document.createElement("label");
    label.textContent = "Online JSON file URL";
    label.htmlFor = `${state.pendingTabId ?? "new-report"}-url`;

    const input = document.createElement("input");
    input.id = `${state.pendingTabId ?? "new-report"}-url`;
    input.type = "url";
    input.placeholder = "https://example.com/tapoo-v2.5.1-agent-api-logs-1788023517.json";
    input.value = state.draftUrl;
    input.addEventListener("input", () => {
      state = {...state, draftUrl: input.value, draftStatus: "empty", draftError: undefined};
      root.dispatchEvent(new Event("input", {bubbles: true}));
    });

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = state.draftStatus === "loading" ? "Loading..." : "Load report";
    submit.disabled = state.draftStatus === "loading";

    form.append(label, input, submit);
    if (state.draftStatus === "error") {
      const error = document.createElement("p");
      error.className = "report-url-error";
      error.textContent = state.draftError;
      form.append(error);
    }
    content.append(form);
    root.append(navigator, content);
  };

  render();
  void restoreSharedReport();
  return root;
}
