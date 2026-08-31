import { describe, expect, it } from "vitest"

import { decodeReportPayload, encodeReportPayload } from "./oracle.js"

// The known-good log, and the shape the encoding is tuned for: a long prefix plus two hex runs.
const gistUrl =
  "https://gist.githubusercontent.com/dmigwi/908ef03ef653fe39581f0756122ffe4c" +
  "/raw/9495b1c9b5c69f0c4276dd0d9ea1ae638be8db58/sample-agent-api-log.json"

const roundTrip = (url) => decodeReportPayload(encodeReportPayload(url).payload)

// Minimal base64url and checksum mirrors, so a test can forge a token the encoder would never emit
// and still have it pass the integrity check - otherwise a forged token would be rejected for the
// wrong reason and prove nothing about the field under test.
const decodeBase64UrlForTest = (token) => {
  const padded = token.replaceAll("-", "+").replaceAll("_", "/")
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

const encodeBase64UrlForTest = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

const withChecksum = (bytes) => {
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
    const {payload} = encodeReportPayload(gistUrl)

    // The assertion the hex packing exists for. Dropping the prefix alone yields a token longer than
    // the URL, because base64 costs 33% - so without packing this feature fails its own goal.
    expect(payload.length).toBeLessThan(gistUrl.length)

    // Tighter than "shorter", because merely shorter is satisfied by a table that matches the
    // generic https:// entry first and leaves the 27-character host in the token. 108 is what the
    // longest-first table produces; the generic match produces 144, also under 145.
    expect(payload.length).toBeLessThanOrEqual(110)
  })

  it("leaves no readable trace of the address", () => {
    const {payload} = encodeReportPayload(gistUrl)

    expect(payload).not.toContain("gist")
    expect(payload).not.toContain("dmigwi")
    expect(payload).not.toContain("sample-agent-api-log")
  })

  it("is URL-safe, so a link cannot be broken by its own token", () => {
    expect(encodeReportPayload(gistUrl).payload).toMatch(/^[A-Za-z0-9_-]+$/)
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
    expect(result.url).toBe(new URL(url).href)
  })

  it("reports a damaged link rather than guessing", () => {
    expect(decodeReportPayload("!!!not base64!!!").ok).toBe(false)
    expect(decodeReportPayload("").ok).toBe(false)
    expect(decodeReportPayload(undefined).ok).toBe(false)
  })

  it("rejects a token naming a prefix that does not exist", () => {
    // First byte is the prefix index; a hand-edited token can name index 99. Rebuilt through the
    // encoder so the checksum is valid and it is genuinely the prefix being rejected.
    const {payload} = encodeReportPayload("https://example.com/log.json")
    const bytes = decodeBase64UrlForTest(payload)
    bytes[0] = 99

    expect(decodeReportPayload(encodeBase64UrlForTest(withChecksum(bytes.slice(0, -2)))).ok).toBe(false)
  })

  it("rejects a single flipped character", () => {
    const {payload} = encodeReportPayload(gistUrl)
    const flipped = `${payload.slice(0, 10)}${payload[10] === "A" ? "B" : "A"}${payload.slice(11)}`

    // Anything short of a checksum lets a one-character change decode into a different, valid URL -
    // reported as a log that could not be retrieved, which sends the reader after the wrong problem.
    expect(decodeReportPayload(flipped).ok).toBe(false)
  })

  it("rejects a truncated token instead of returning a shortened URL", () => {
    const {payload} = encodeReportPayload(gistUrl)
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
