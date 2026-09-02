import {afterEach, describe, expect, it, vi} from "vitest"

import {decodeReportPayload, encodeReportPayload, fetchOnlineJsonText} from "./share-link"
import {expectErr, expectOk} from "./test-support";

// The known-good log, and the shape the encoding is tuned for: a long prefix plus two hex runs.
const gistUrl =
  "https://gist.githubusercontent.com/dmigwi/908ef03ef653fe39581f0756122ffe4c" +
  "/raw/9495b1c9b5c69f0c4276dd0d9ea1ae638be8db58/sample-agent-api-log.json"

const roundTrip = (url: string) => decodeReportPayload(expectOk(encodeReportPayload(url)).payload)

afterEach(() => vi.unstubAllGlobals())

describe("fetchOnlineJsonText", () => {
  it("omits credentials and referrer data from cross-origin report requests", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchOnlineJsonText("https://example.com/log.json")).resolves.toBe("{}")
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/log.json", expect.objectContaining({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    }))
  })

  it("rejects a report whose declared size exceeds the configured limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("too large", {
      headers: {"content-length": "10"},
    })))

    await expect(fetchOnlineJsonText("https://example.com/log.json", {maxBytes: 5}))
      .rejects.toThrow("exceeds the 5 byte")
  })

  it("stops a streamed report once it exceeds the configured limit", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456"))
      },
    })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)))

    await expect(fetchOnlineJsonText("https://example.com/log.json", {maxBytes: 5}))
      .rejects.toThrow("exceeds the 5 byte")
  })
})

// Minimal base64url and checksum mirrors, so a test can forge a token the encoder would never emit
// and still have it pass the integrity check - otherwise a forged token would be rejected for the
// wrong reason and prove nothing about the field under test.
const decodeBase64UrlForTest = (token: string) => {
  const padded = token.replaceAll("-", "+").replaceAll("_", "/")
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

const encodeBase64UrlForTest = (bytes: Iterable<number>) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

const withChecksum = (bytes: Iterable<number>) => {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const folded = ((hash >>> 16) ^ (hash & 0xffff)) & 0xffff
  return [...bytes, folded >>> 8, folded & 0xff]
}

describe("encodeReportPayload", () => {
  it("produces a token shorter than the URL it replaces", () => {
    const {payload} = expectOk(encodeReportPayload(gistUrl))

    // The assertion the hex packing exists for. Dropping the prefix alone yields a token longer than
    // the URL, because base64 costs 33% - so without packing this feature fails its own goal.
    expect(payload.length).toBeLessThan(gistUrl.length)

    // Tighter than "shorter", because merely shorter is satisfied by a table that matches the
    // generic https:// entry first and leaves the 27-character host in the token. 108 is what the
    // longest-first table produces; the generic match produces 144, also under 145.
    expect(payload.length).toBeLessThanOrEqual(110)
  })

  it("leaves no readable trace of the address", () => {
    const {payload} = expectOk(encodeReportPayload(gistUrl))

    expect(payload).not.toContain("gist")
    expect(payload).not.toContain("dmigwi")
    expect(payload).not.toContain("sample-agent-api-log")
  })

  it("is URL-safe, so a link cannot be broken by its own token", () => {
    expect(expectOk(encodeReportPayload(gistUrl)).payload).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("refuses a URL the loader would refuse", () => {
    // The same gate as the form, so a link cannot carry something typing could not.
    expect(encodeReportPayload("not a url").ok).toBe(false)
    expect(encodeReportPayload("ftp://example.com/log.json").ok).toBe(false)
    expect(encodeReportPayload("").ok).toBe(false)
  })
})

describe("decodeReportPayload", () => {
  // Weighted away from gist on purpose: those are the URLs a gist-shaped encoder would quietly
  // mangle, and any http(s) JSON URL has to keep working.
  it.each([
    ["a gist raw URL", gistUrl],
    ["a raw.githubusercontent URL", "https://raw.githubusercontent.com/dmigwi/tapoo/master/log.json"],
    ["an unrelated host", "https://example.com/log.json"],
    ["a host with a port", "https://example.com:8443/logs/log.json"],
    ["a URL with a query string", "https://example.com/log.json?token=abc123&v=2"],
    ["a URL with a fragment", "https://example.com/log.json#section"],
    ["a percent-encoded path", "https://example.com/logs/a%20file%20name.json"],
    ["a non-ASCII path", "https://example.com/logs/ünïcode-log.json"],
    ["plain http", "http://localhost:4321/log.json"],
    ["no hex segments at all", "https://example.com/a/b/c/d.json"],
    ["an odd-length hex segment", "https://example.com/abcdef0123456789a/log.json"],
    ["uppercase hex, which cannot pack", "https://example.com/908EF03EF653FE39581F0756122FFE4C/log.json"],
  ])("round-trips %s", (unused, url) => {
    const result = roundTrip(url)

    expect(result.ok).toBe(true)
    expect(expectOk(result).url).toBe(new URL(url).href)
  })

  it("reports a damaged link rather than guessing", () => {
    expect(decodeReportPayload("!!!not base64!!!").ok).toBe(false)
    expect(decodeReportPayload("").ok).toBe(false)
    expect(decodeReportPayload(undefined).ok).toBe(false)
  })

  it("names the broken link in the message, so a reader can tell which one failed", () => {
    // The identifier belongs to the decoder, not to whichever caller happens to render the failure:
    // every rejection here is the same failure and needs the same handle on it.
    const {payload} = expectOk(encodeReportPayload(gistUrl))
    const truncated = `${payload.slice(0, -2)}zz`

    const result = decodeReportPayload(truncated)
    expect(result.ok).toBe(false)
    // Shown as the link's own shape, so it reads as a URL rather than a string of characters.
    expect(expectErr(result).link).toContain(`/r/${truncated.slice(0, 10)}`)
    expect(expectErr(result).link).toContain(truncated.slice(-8))
    // Both ends, not the whole token: it identifies the link, it does not dump the payload.
    expect(expectErr(result).link).not.toContain(truncated)
  })

  // The two sentences are asserted literally here and nowhere else. Every other case below compares
  // against these instead of repeating the prose, so rewording a message is a one-line change rather
  // than a sweep through the file - which it was, three times over, before this was pulled out.
  const UNNAMED = "This link does not name a report."
  const ALTERED = "This link has been truncated, altered or damaged. Ask for a fresh link."

  it("gives the reason alone when there is no link to point at", () => {
    const result = decodeReportPayload("")

    expect(expectErr(result).error).toBe(UNNAMED)
    expect(expectErr(result).link).toBeNull()
  })

  // Pins the contract: every rejection past "no token at all" carries the same sentence and names the
  // link.
  //
  // With one sentence for all of them these cannot, on their own, prove which guard fired - an input
  // that slips past its own guard is caught by the next one and reports identically. Checked by
  // removing guards one at a time: the overshooting run does fail without its own guard, while a
  // too-short token is caught by the checksum guard regardless, so that length check is defensive
  // rather than load-bearing.
  it.each([
    ["characters no token contains", "!!!not-a-token!!!"],
    ["a token too short to carry an address", "AQ"],
    ["a run that overshoots the token", encodeBase64UrlForTest(withChecksum(Uint8Array.from([0, 104, 105, 0x01, 200])))],
    ["a token altered in transit", null]
  ])("rejects %s", (_label, token) => {
    const value = token ?? `${expectOk(encodeReportPayload(gistUrl)).payload.slice(0, -2)}zz`
    const result = decodeReportPayload(value)

    expect(result.ok).toBe(false)
    // One sentence for every one of them, and never the unnamed one - a token that was present but
    // unusable is a different situation from a link that named nothing at all.
    expect(expectErr(result).error).toBe(ALTERED)
    expect(expectErr(result).error).not.toBe(UNNAMED)
    // The link is a value, not part of the sentence: the view marks it up as code.
    expect(expectErr(result).link).toMatch(/^(https?:\/\/[^/]+)?\/r\//)
  })

  it("rejects a token naming a prefix that does not exist", () => {
    // First byte is the prefix index; a hand-edited token can name index 99. Rebuilt through the
    // encoder so the checksum is valid and it is genuinely the prefix being rejected.
    const {payload} = expectOk(encodeReportPayload("https://example.com/log.json"))
    const bytes = decodeBase64UrlForTest(payload)
    bytes[0] = 99

    const result = decodeReportPayload(encodeBase64UrlForTest(withChecksum(bytes.slice(0, -2))))

    expect(result.ok).toBe(false)
    expect(expectErr(result).error).toBe(ALTERED)
  })

  it("rejects a single flipped character", () => {
    const {payload} = expectOk(encodeReportPayload(gistUrl))
    const flipped = `${payload.slice(0, 10)}${payload[10] === "A" ? "B" : "A"}${payload.slice(11)}`

    // Anything short of a checksum lets a one-character change decode into a different, valid URL -
    // reported as a log that could not be retrieved, which sends the reader after the wrong problem.
    expect(decodeReportPayload(flipped).ok).toBe(false)
  })

  it("rejects a truncated token instead of returning a shortened URL", () => {
    const {payload} = expectOk(encodeReportPayload(gistUrl))
    const result = decodeReportPayload(payload.slice(0, payload.length - 8))

    // A hex run claiming more bytes than remain is a link a chat client cut, not a different log.
    expect(result.ok).toBe(false)
  })

  it("rejects a token whose decoded value would not pass the loader's own check", () => {
    // Prefix index 3 is http://, and what follows leaves a URL with no host at all. Checksummed, so
    // it is rejected by the validation at the end rather than bounced by the integrity check first -
    // without that this passes even when the validation is removed.
    const forged = encodeBase64UrlForTest(withChecksum([3, ...[..."/////"].map((c) => c.charCodeAt(0))]))

    expect(decodeReportPayload(forged).ok).toBe(false)
  })

  it("rejects a hex run claiming more bytes than the token holds", () => {
    // Prefix index 2 is https://, then "e.com/", then a run announcing 200 bytes that are not there.
    const forged = encodeBase64UrlForTest(withChecksum([
      2,
      ...[..."e.com/"].map((c) => c.charCodeAt(0)),
      0x01,
      200,
      0xff,
    ]))

    // Reachable only with a valid checksum, so this is the framing guard being tested and not the
    // integrity check standing in front of it.
    expect(decodeReportPayload(forged).ok).toBe(false)
  })
})
