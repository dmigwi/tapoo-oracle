// Share links: the /r/<token> route, and the codec behind the token.
//
// Split out of the log contract, which is about what Tapoo writes; this is about what the Oracle
// hands a reader. Keeping the codec beside the routes matters: the two halves are the reason a
// damaged token needs both an address to show and a reason to show it, and separating them is how
// one failure path ended up with no link to name.

import {parseTapooLogText} from "./log-contract";
import type {DecodedPayload, LogWarning, PayloadResult, TapooLog, UrlResult} from "./types";
import {asTrimmedText} from "./untrusted";

// --- Online JSON URLs ---

// validateOnlineJsonUrl is the only gate on what may be loaded. Everything downstream - the codec, the
// loader, the share link - takes its word for it.
export function validateOnlineJsonUrl(value: unknown): UrlResult {
  const trimmed = asTrimmedText(value);
  if (!trimmed) {
    return {ok: false, error: "Enter an online JSON file URL."};
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {ok: false, error: "Enter a valid URL."};
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return {ok: false, error: "Use an online http:// or https:// JSON URL."};
  }

  if (url.username || url.password) {
    return {ok: false, error: "Do not put credentials in the report URL."};
  }

  return {ok: true, url: url.href};
}

// --- Fetching a log ---

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REPORT_BYTES = 25 * 1024 * 1024;

type FetchLimits = {timeoutMs?: number; maxBytes?: number};

export async function fetchOnlineJsonText(
  url: string,
  {timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, maxBytes = DEFAULT_MAX_REPORT_BYTES}: FetchLimits = {},
): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || "HTTP error"}`);
  }

  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new Error(`Report exceeds the ${maxBytes} byte download limit`);
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`Report exceeds the ${maxBytes} byte download limit`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;

  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Report exceeds the ${maxBytes} byte download limit`);
    }
    chunks.push(decoder.decode(value, {stream: true}));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

// fetchFailureMessage turns what fetch throws into something a reader can act on.
//
// A refused cross-origin request arrives as a bare TypeError with no status - the same shape as an
// offline browser - and "Failed to fetch" tells a reader nothing about which of the two it was. This is
// the one failure where a link that works for whoever shared it can fail for whoever opens it.
export function fetchFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
    return "Could not load the log before the request timed out.";
  }
  if (error instanceof TypeError) {
    return `Could not reach the log: ${message}. The host may be offline, or may not allow other sites to read it.`;
  }

  return `Could not load the log: ${message}. It may have been deleted, or may no longer be public.`;
}

/** What loadTapooLogFromUrl returns. Stated exactly rather than as an intersection: a success always
 * carries the parsed log and the URL it came from, while a failure carries the URL only when there was
 * one to report - a URL that never validated has none. */
export type LoadedLog =
  | {ok: true; source: TapooLog; warnings: LogWarning[]; url: string}
  | {ok: false; error: string; url?: string};

export async function loadTapooLogFromUrl(
  value: unknown,
  {fetchText = fetchOnlineJsonText}: {fetchText?: (url: string) => Promise<string>} = {},
): Promise<LoadedLog> {
  const validation = validateOnlineJsonUrl(value);
  if (!validation.ok) {
    return validation;
  }

  try {
    const text = await fetchText(validation.url);
    const result = parseTapooLogText(text, {sourceUrl: validation.url});
    return {...result, url: validation.url};
  } catch (error) {
    return {ok: false, error: fetchFailureMessage(error), url: validation.url};
  }
}

// --- The report route ---

// The route a shared report lives at. Namespaced under /r/ rather than sitting at the root so it
// reads as a route, and so a future host with real routing can serve it without having to guess
// whether a path segment is a token or a page.
const REPORT_ROUTE = "r";

const REPORT_ROUTE_PATTERN = new RegExp(`/${REPORT_ROUTE}/([A-Za-z0-9_-]+)/?$`);

// The fragment hop carries the same marker the path form does.
//
// A bare #<token> cannot be told apart from an ordinary page anchor: base64url tokens use the same
// characters a slug does, so #section-two and a real token are the same shape. The path form never had
// this problem because the literal /r/ segment marks it, and this restores that symmetry. Everything
// after the marker is captured, damaged or not, so a mangled token still reaches decodeReportPayload
// and is reported as a damaged link rather than silently ignored.
const REPORT_PAYLOAD_FRAGMENT_PATTERN = new RegExp(`^#?${REPORT_ROUTE}=(.+)$`);

/** Only the parts of Location this module reads, so a test can pass a plain object. */
export type AppLocation = {origin: string; pathname: string};

const currentLocation = (): AppLocation | undefined => globalThis.location;

// appBasePath finds where the app is served from, given any page within it.
//
// It has to strip a report route back off, because the address bar of a shared report already
// carries one - composing a new link from that pathname would otherwise nest /r/ inside /r/. It also
// drops a trailing file name so /index.html and / produce the same base.
export function appBasePath(pathname: string = "/"): string {
  const withoutRoute = String(pathname).replace(REPORT_ROUTE_PATTERN, "/");
  const withoutFile = withoutRoute.replace(/[^/]*\.html?$/, "");
  return withoutFile.endsWith("/") ? withoutFile : `${withoutFile}/`;
}

// reportRouteFor composes the public form of a link from a token. Every address the reader is left
// looking at goes through here, so the route is built one way only.
export function reportRouteFor(token: string, location: AppLocation): string {
  return `${location.origin}${appBasePath(location.pathname)}${REPORT_ROUTE}/${token}`;
}

// appRootFor is where a reader is left when no token can be shown - never the fragment, which is an
// internal hop and not an address anyone should be handed.
export function appRootFor(location: AppLocation): string {
  return `${location.origin}${appBasePath(location.pathname)}`;
}

// reportPayloadFromPath reads the token out of a /r/<token> route.
export function reportPayloadFromPath(pathname: unknown): string | null {
  return REPORT_ROUTE_PATTERN.exec(asTrimmedText(pathname))?.[1] ?? null;
}

// reportPayloadFromHash reads a token out of a location fragment.
//
// Not the shape anyone is given: it is how 404.md hands the token to the app, since a static host
// cannot serve the app at an arbitrary path without a redirect. Kept separate from the route reader
// so the public form and the internal hop can change independently.
export function reportPayloadFromHash(hash: unknown): string | null {
  return REPORT_PAYLOAD_FRAGMENT_PATTERN.exec(asTrimmedText(hash))?.[1] ?? null;
}

// --- Token format ---

// Prefixes worth dropping, longest match first. This is a compression table and never an allowlist:
// validateOnlineJsonUrl remains the only gate on what may be loaded, so a URL on any other host
// encodes and decodes exactly the same way - it just has less in common with the table and so
// compresses less. The two generic entries mean every http(s) URL matches something.
const REPORT_PAYLOAD_PREFIXES = [
  "https://gist.githubusercontent.com/",
  "https://raw.githubusercontent.com/",
  "https://",
  "http://",
];

// Marks a packed hex run inside the byte stream. 0x01 cannot occur in the text of a URL - control
// characters are percent-encoded by URL normalization long before they reach here - so no escaping is
// needed to tell a marker apart from content.
const REPORT_PAYLOAD_HEX_MARKER = 0x01;

// Below this a run costs more in framing than it saves. 16 hex characters pack to 8 bytes plus 2 of
// framing; shorter runs are left as text.
const REPORT_PAYLOAD_HEX_MIN = 16;

// Two trailing bytes over the rest of the token, so a link altered in transit is caught rather than
// decoded into a different, valid-looking address.
function reportPayloadIntegrityBytes(bytes: ArrayLike<number> & Iterable<number>): [number, number] {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  const folded = ((hash >>> 16) ^ (hash & 0xffff)) & 0xffff;
  return [folded >>> 8, folded & 0xff];
}

function base64UrlFromBytes(bytes: Iterable<number>): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function bytesFromBase64Url(token: string): Uint8Array {
  const padded = token.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isPackableHexSegment(segment: string): boolean {
  return (
    segment.length >= REPORT_PAYLOAD_HEX_MIN &&
    segment.length % 2 === 0 &&
    /^[0-9a-f]+$/.test(segment)
  );
}

// --- Why a link failed ---

const LINK_UNNAMED = "This link does not name a report.";

const LINK_ALTERED = "This link has been truncated, altered or damaged. Ask for a fresh link.";

// elideToken keeps both ends of an opaque token. The head is what a reader matches at a glance against
// the link they were sent; the tail is where truncation and transcription damage actually shows up. A
// tail alone reads as random text, which is the one thing this label must not do.
const elideToken = (token: string, head = 10, tail = 12): string =>
  token.length <= head + tail + 3 ? token : `${token.slice(0, head)}...${token.slice(-tail)}`;

// damagedLinkLabel shows the failure in the shape the reader was actually handed - origin, base path,
// /r/, then the elided token. The scheme and host are what make it recognizable as a URL at a glance
// rather than a string of characters. Off a browser there is no origin to name, so it degrades to the
// route path, which still reads as a link.
export function damagedLinkLabel(token: string): string {
  const elided = elideToken(token);
  const location = currentLocation();
  return location?.origin ? reportRouteFor(elided, location) : `/${REPORT_ROUTE}/${elided}`;
}

const rejectedLink = (
  reason: string,
  token: string,
  linkLabel: (value: string) => string,
): DecodedPayload => ({ok: false, error: reason, link: token ? linkLabel(token) : null});

// --- Encoding and decoding ---

export function encodeReportPayload(value: unknown): PayloadResult {
  const validation = validateOnlineJsonUrl(value);
  if (!validation.ok) {
    return validation;
  }

  const index = REPORT_PAYLOAD_PREFIXES.findIndex((prefix) => validation.url.startsWith(prefix));
  const prefix = REPORT_PAYLOAD_PREFIXES[index];
  // Unreachable: the table's last two entries match every http(s) URL, and validateOnlineJsonUrl
  // admits nothing else. Stated rather than asserted so the reason survives a change to the table.
  if (prefix === undefined) {
    return {ok: false, error: "Enter an online http:// or https:// JSON URL."};
  }

  const encoder = new TextEncoder();
  const bytes: number[] = [index];

  validation.url.slice(prefix.length).split("/").forEach((segment, position) => {
    if (position > 0) {
      bytes.push(...encoder.encode("/"));
    }

    if (!isPackableHexSegment(segment)) {
      bytes.push(...encoder.encode(segment));
      return;
    }

    bytes.push(REPORT_PAYLOAD_HEX_MARKER, segment.length / 2);
    for (let at = 0; at < segment.length; at += 2) {
      bytes.push(Number.parseInt(segment.slice(at, at + 2), 16));
    }
  });

  return {
    ok: true,
    payload: base64UrlFromBytes(Uint8Array.from([...bytes, ...reportPayloadIntegrityBytes(bytes)])),
  };
}

export function decodeReportPayload(
  value: unknown,
  {linkLabel = damagedLinkLabel}: {linkLabel?: (token: string) => string} = {},
): DecodedPayload {
  const token = asTrimmedText(value);
  if (!token) {
    return rejectedLink(LINK_UNNAMED, "", linkLabel);
  }

  let framed: Uint8Array;
  try {
    framed = bytesFromBase64Url(token);
  } catch {
    return rejectedLink(LINK_ALTERED, token, linkLabel);
  }

  const bytes = framed.subarray(0, framed.length - 2);
  const [high, low] = reportPayloadIntegrityBytes(bytes);
  if (framed[framed.length - 2] !== high || framed[framed.length - 1] !== low) {
    return rejectedLink(LINK_ALTERED, token, linkLabel);
  }

  const prefixIndex = bytes[0];
  const prefix = prefixIndex === undefined ? undefined : REPORT_PAYLOAD_PREFIXES[prefixIndex];
  if (prefix === undefined) {
    return rejectedLink(LINK_ALTERED, token, linkLabel);
  }

  const decoder = new TextDecoder();
  let rest = "";
  let literalFrom = 1;

  for (let at = 1; at < bytes.length; at += 1) {
    if (bytes[at] !== REPORT_PAYLOAD_HEX_MARKER) {
      continue;
    }

    const count = bytes[at + 1];
    if (count === undefined || at + 2 + count > bytes.length) {
      return rejectedLink(LINK_ALTERED, token, linkLabel);
    }

    rest += decoder.decode(bytes.subarray(literalFrom, at));
    rest += [...bytes.subarray(at + 2, at + 2 + count)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    at += 1 + count;
    literalFrom = at + 1;
  }

  const address = rest + decoder.decode(bytes.subarray(literalFrom));
  if (!address) {
    return rejectedLink(LINK_ALTERED, token, linkLabel);
  }

  // A URL that fails validation here is a damaged token like any other, and must carry the link that
  // names it. Returning validateOnlineJsonUrl's result directly - as this did - produced a failure
  // with no `link`, and the one caller reading `decoded.link` unconditionally lost the
  // "(broken link: ...)" hint on exactly this path.
  const validated = validateOnlineJsonUrl(prefix + address);
  return validated.ok ? validated : rejectedLink(LINK_ALTERED, token, linkLabel);
}

// shareLinkFor composes the link that reproduces one report.
//
// The token is a path segment, which means it is sent to the host: GitHub Pages will have the
// (recoverable) log address in its request logs, and every shared link is served with a 404 status
// through the shim in 404.md. That trade was made deliberately for a link that reads as a link.
export function shareLinkFor(url: unknown, location: AppLocation | undefined = currentLocation()): string | null {
  const encoded = encodeReportPayload(url);
  if (!encoded.ok || !location) {
    return null;
  }

  return reportRouteFor(encoded.payload, location);
}
