/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  createReportTabsInput,
  describeFetchFailure,
  encodeReportPayload,
  reportPayloadFromHash,
  shareLinkFor,
} from "./oracle.js"

const gistUrl =
  "https://gist.githubusercontent.com/dmigwi/908ef03ef653fe39581f0756122ffe4c" +
  "/raw/9495b1c9b5c69f0c4276dd0d9ea1ae638be8db58/sample-agent-api-log.json"

const logExport = JSON.stringify({
  name: "tapoo",
  version: "2.5.1",
  mode: "agent-api",
  downloadedAt: "2026-08-31T09-00-00+02-00",
  entries: [{epochMs: 1, time: "t", level: 1, turn: 0, game: 1, log: "info", payload: "Agent level started."}],
})

// Lets a test wait for the load the component kicks off without reaching into its internals.
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0) })

const panelText = (node) => node.querySelector(".report-active-panel")?.textContent ?? ""

describe("shareLinkFor", () => {
  const location = {origin: "https://example.github.io", pathname: "/tapoo-oracle/"}

  it("puts the token in the fragment, never the query string", () => {
    const link = shareLinkFor(gistUrl, location)

    // A query string is sent to the host on every visit, so GitHub Pages would log the (recoverable)
    // address of every log anyone shared - while the footer of this app says logs are analyzed in
    // the browser and never uploaded. A fragment never leaves the browser.
    expect(link.startsWith("https://example.github.io/tapoo-oracle/#payload=")).toBe(true)
    expect(link).not.toContain("?")
  })

  it("carries no readable trace of the log address", () => {
    expect(shareLinkFor(gistUrl, location)).not.toContain("gist.githubusercontent.com")
  })

  it("returns nothing for a URL that cannot be encoded", () => {
    expect(shareLinkFor("not a url", location)).toBeNull()
  })
})

describe("reportPayloadFromHash", () => {
  it("reads the token out of a fragment", () => {
    expect(reportPayloadFromHash("#payload=abc123")).toBe("abc123")
  })

  it("ignores a fragment that carries something else", () => {
    expect(reportPayloadFromHash("#section-two")).toBeNull()
    expect(reportPayloadFromHash("")).toBeNull()
    expect(reportPayloadFromHash(undefined)).toBeNull()
  })
})

describe("describeFetchFailure", () => {
  it("names the cross-origin case, which a bare TypeError does not", () => {
    // The one failure where a link that works for the sharer fails for the reader.
    expect(describeFetchFailure(new TypeError("Failed to fetch"))).toMatch(/allow other sites/)
  })

  it("suggests the likely cause of a status failure", () => {
    expect(describeFetchFailure(new Error("404 Not Found"))).toMatch(/deleted|public/)
  })
})

describe("createReportTabsInput sharing", () => {
  beforeEach(() => {
    window.location.hash = ""
    vi.restoreAllMocks()
  })

  it("leaves nothing in the DOM that can be turned back into a working log address", async () => {
    window.location.hash = `#payload=${encodeReportPayload(gistUrl).payload}`
    const node = createReportTabsInput({fetchText: async () => logExport})
    document.body.append(node)
    await settle()

    // The trimmed URL stays on display deliberately - host and filename are what tell a reader which
    // report they are looking at. What must not survive is anything that reconstitutes a fetchable
    // address: the whole URL, the gist id, or the revision sha.
    expect(node.innerHTML).not.toContain(gistUrl)
    expect(node.innerHTML).not.toContain("908ef03ef653fe39581f0756122ffe4c")
    expect(node.innerHTML).not.toContain("9495b1c9b5c69f0c4276dd0d9ea1ae638be8db58")

    // And nothing may carry it in an attribute, where it is invisible on screen but plain in the
    // source - the two title attributes this change removed did exactly that.
    for (const element of node.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.value).not.toContain("908ef03ef653fe39581f0756122ffe4c")
      }
    }

    node.remove()
  })

  it("rebuilds the report a shared link names, with no input", async () => {
    window.location.hash = `#payload=${encodeReportPayload(gistUrl).payload}`
    const fetchText = vi.fn(async () => logExport)
    const node = createReportTabsInput({fetchText})
    await settle()

    expect(fetchText).toHaveBeenCalledWith(gistUrl)
    expect(node.value.tabs).toHaveLength(1)
    expect(node.value.tabs[0].status).toBe("loaded")
  })

  it("says the link is damaged rather than that the log is missing", async () => {
    window.location.hash = "#payload=!!!not-a-token!!!"
    const fetchText = vi.fn(async () => logExport)
    const node = createReportTabsInput({fetchText})
    await settle()

    // Distinct from a retrieval failure on purpose: nothing was ever fetched, and the reader's only
    // remedy is a fresh link.
    expect(fetchText).not.toHaveBeenCalled()
    expect(panelText(node)).toMatch(/damaged/i)
  })

  it("reports a log that could not be retrieved as its own failure", async () => {
    window.location.hash = `#payload=${encodeReportPayload(gistUrl).payload}`
    const node = createReportTabsInput({fetchText: async () => { throw new Error("404 Not Found") }})
    await settle()

    const [tab] = node.value.tabs
    expect(tab.status).toBe("error")
    expect(tab.error).toMatch(/404 Not Found/)
    expect(tab.error).not.toMatch(/damaged/i)
  })

  it("puts the loaded report in the address bar, without stacking history entries", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState")
    const pushState = vi.spyOn(window.history, "pushState")
    const node = createReportTabsInput({fetchText: async () => logExport})
    document.body.append(node)

    const input = node.querySelector("input[type=url]")
    input.value = gistUrl
    input.dispatchEvent(new window.Event("input", {bubbles: true}))
    node.querySelector("form").dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}))
    await settle()

    expect(replaceState).toHaveBeenCalledWith(null, "", expect.stringContaining("#payload="))
    // Assigning location.hash would push an entry, so loading three reports would take three presses
    // of Back to leave the page.
    expect(pushState).not.toHaveBeenCalled()
    node.remove()
  })

  it("leaves the address bar alone when a report fails to load", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState")
    const node = createReportTabsInput({fetchText: async () => { throw new Error("404 Not Found") }})
    document.body.append(node)

    const input = node.querySelector("input[type=url]")
    input.value = gistUrl
    input.dispatchEvent(new window.Event("input", {bubbles: true}))
    node.querySelector("form").dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}))
    await settle()

    // A link to a report this browser could not read is not worth handing to anyone.
    expect(replaceState).not.toHaveBeenCalled()
    node.remove()
  })

  it("loads nothing when the fragment holds no token", async () => {
    const fetchText = vi.fn(async () => logExport)
    createReportTabsInput({fetchText})
    await settle()

    expect(fetchText).not.toHaveBeenCalled()
  })
})
