/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

import {createReportTabsInput} from "./report-tabs-control"
import {appBasePath, reportPayloadFromHash, reportPayloadFromPath, shareLinkFor} from "./share-link"
import {encodeReportPayload, fetchFailureMessage} from "./share-link"
import {at, expectOk, must, query, queryAll} from "./test-support";

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

const panelText = (node: ParentNode) => node.querySelector(".report-active-panel")?.textContent ?? ""

describe("appBasePath", () => {
  it.each([
    ["a site root", "/", "/"],
    ["a project page", "/tapoo-oracle/", "/tapoo-oracle/"],
    ["an explicit index", "/tapoo-oracle/index.html", "/tapoo-oracle/"],
  ])("keeps %s as the base", (unused, pathname, expected) => {
    expect(appBasePath(pathname)).toBe(expected)
  })

  it("strips a report route back off", () => {
    // The address bar of an open report already carries /r/<token>. Composing the next link from it
    // without stripping would nest one route inside another.
    expect(appBasePath("/tapoo-oracle/r/AbC-123_x")).toBe("/tapoo-oracle/")
    expect(appBasePath("/r/AbC-123_x")).toBe("/")
  })
})

describe("shareLinkFor", () => {
  const location = {origin: "https://example.github.io", pathname: "/tapoo-oracle/"}

  it("puts the token in the path, under the report route", () => {
    const {payload} = expectOk(encodeReportPayload(gistUrl))

    expect(shareLinkFor(gistUrl, location)).toBe(
      `https://example.github.io/tapoo-oracle/r/${payload}`,
    )
  })

  it("reads as a plain link, with no fragment or query", () => {
    const link = shareLinkFor(gistUrl, location)

    expect(link).not.toContain("#")
    expect(link).not.toContain("?")
  })

  it("does not nest a route when composed from a page already showing one", () => {
    const {payload} = expectOk(encodeReportPayload(gistUrl))
    const onReport = {origin: "https://example.github.io", pathname: `/tapoo-oracle/r/${payload}`}

    expect(shareLinkFor(gistUrl, onReport)).toBe(
      `https://example.github.io/tapoo-oracle/r/${payload}`,
    )
  })

  it("carries no readable trace of the log address", () => {
    expect(shareLinkFor(gistUrl, location)).not.toContain("gist.githubusercontent.com")
  })

  it("returns nothing for a URL that cannot be encoded", () => {
    expect(shareLinkFor("not a url", location)).toBeNull()
  })
})

describe("reportPayloadFromPath", () => {
  it("reads the token out of a report route", () => {
    expect(reportPayloadFromPath("/tapoo-oracle/r/AbC-123_x")).toBe("AbC-123_x")
    expect(reportPayloadFromPath("/r/AbC-123_x/")).toBe("AbC-123_x")
  })

  it("ignores a path that names no report", () => {
    expect(reportPayloadFromPath("/tapoo-oracle/")).toBeNull()
    expect(reportPayloadFromPath("/r/")).toBeNull()
    expect(reportPayloadFromPath(undefined)).toBeNull()
  })
})

describe("reportPayloadFromHash", () => {
  // Not a shape anyone is handed: it is how 404.md hands the token to an app the host cannot serve
  // at an arbitrary path. It carries the same "r=" marker the /r/ path segment does.
  it("reads the token out of the redirect hop", () => {
    expect(reportPayloadFromHash("#r=abc123")).toBe("abc123")
  })

  it("ignores a fragment that carries something else", () => {
    // Without the marker a plain anchor is the same shape as a token - base64url uses the characters a
    // slug does - so the marker is the only thing that can tell them apart.
    expect(reportPayloadFromHash("#section-two")).toBeNull()
    expect(reportPayloadFromHash("#abc123")).toBeNull()
    expect(reportPayloadFromHash("")).toBeNull()
    expect(reportPayloadFromHash(undefined)).toBeNull()
  })

  it("keeps a token that uses the whole base64url alphabet", () => {
    // Real tokens contain - and _; a rule that rejected either would break live share links.
    expect(reportPayloadFromHash("#r=ab-cd_ef")).toBe("ab-cd_ef")
  })
})

describe("fetchFailureMessage", () => {
  it("names the cross-origin case, which a bare TypeError does not", () => {
    // The one failure where a link that works for the sharer fails for the reader.
    expect(fetchFailureMessage(new TypeError("Failed to fetch"))).toMatch(/allow other sites/)
  })

  it("suggests the likely cause of a status failure", () => {
    expect(fetchFailureMessage(new Error("404 Not Found"))).toMatch(/deleted|public/)
  })
})

describe("createReportTabsInput sharing", () => {
  beforeEach(() => {
    // Both, because a test that loads a report leaves /r/<token> in the path via replaceState, and
    // the next test would then find a token it never set.
    window.history.replaceState(null, "", "/")
    window.location.hash = ""
    vi.restoreAllMocks()
  })

  it("leaves nothing in the DOM that can be turned back into a working log address", async () => {
    window.location.hash = `#r=${expectOk(encodeReportPayload(gistUrl)).payload}`
    const node = createReportTabsInput({fetchText: async () => logExport})
    document.body.append(node)
    await settle()

    // Strict now that the panel shows the share link instead of the log address: no part of the
    // address survives anywhere, not even the host. The report is named by its label instead.
    expect(node.innerHTML).not.toContain(gistUrl)
    expect(node.innerHTML).not.toContain("gist.githubusercontent.com")
    expect(node.innerHTML).not.toContain("908ef03ef653fe39581f0756122ffe4c")
    expect(node.innerHTML).not.toContain("9495b1c9b5c69f0c4276dd0d9ea1ae638be8db58")
    expect(node.textContent).toContain("sample-agent-api-log.json")

    // And nothing may carry it in an attribute, where it is invisible on screen but plain in the
    // source - the two title attributes this change removed did exactly that.
    for (const element of node.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.value).not.toContain("908ef03ef653fe39581f0756122ffe4c")
      }
    }

    node.remove()
  })

  it("never renders the decoded address, not even while the report is loading", async () => {
    window.history.replaceState(null, "", `/r/${expectOk(encodeReportPayload(gistUrl)).payload}`)
    let release = () => {}
    const node = createReportTabsInput({
      fetchText: () => new Promise<string>((resolve) => { release = () => { resolve(logExport) } }),
    })
    document.body.append(node)
    await settle()

    // Mid-load is the window that matters: routing the restore through the add-report form would put
    // the full address in an input for as long as the fetch takes.
    expect(node.innerHTML).not.toContain("908ef03ef653fe39581f0756122ffe4c")
    expect(node.textContent).toMatch(/Opening the shared report/)

    release()
    await settle()

    expect(node.innerHTML).not.toContain("908ef03ef653fe39581f0756122ffe4c")
    node.remove()
  })

  it("shows the share link on the panel, not the log address", async () => {
    window.history.replaceState(null, "", `/r/${expectOk(encodeReportPayload(gistUrl)).payload}`)
    const node = createReportTabsInput({fetchText: async () => logExport})
    document.body.append(node)
    await settle()

    // Showing both was showing the same thing twice: the link encodes the address, so the second
    // copy added only the address itself, in readable form, on the panel people screenshot.
    const shown = query(node, ".report-source-url").textContent
    expect(shown).toContain("/r/")
    expect(shown).not.toContain("gist")

    // Whole, not trimmed. Someone selecting the link by hand must get one that works, and an
    // ellipsis in the middle of a link is the one place trimming produces something broken.
    expect(shown).toBe(shareLinkFor(gistUrl))
    expect(shown).not.toContain("\u2026")
    node.remove()
  })

  it("puts the share control beside the link, with the chain icon on the button", async () => {
    window.history.replaceState(null, "", `/r/${expectOk(encodeReportPayload(gistUrl)).payload}`)
    const node = createReportTabsInput({fetchText: async () => logExport})
    document.body.append(node)
    await settle()

    const panel = query(node, ".report-share-panel")
    expect(panel.querySelector(".report-source-url")).not.toBeNull()

    const button = query(panel, ".report-share")
    // Inline, so an icon cannot fail to load and leave a bare word looking like a broken control.
    expect(button.querySelector("svg")).not.toBeNull()
    // Named for what it produces. "Copy" describes the clipboard; the reader wants a link.
    expect(button.textContent).toContain("Share Report Link")
    expect(query(panel, ".report-share-disclosure").textContent).toMatch(/reversibly contains the source URL/)
    node.remove()
  })

  it("keeps the icon when the button reports what it did", async () => {
    window.history.replaceState(null, "", `/r/${expectOk(encodeReportPayload(gistUrl)).payload}`)
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", {clipboard: {writeText}})
    const node = createReportTabsInput({fetchText: async () => logExport})
    document.body.append(node)
    await settle()

    query(node, ".report-share").click()
    await settle()

    // Writing the state with textContent would replace the icon along with the label.
    expect(writeText).toHaveBeenCalledWith(shareLinkFor(gistUrl))
    expect(node.querySelector(".report-share svg")).not.toBeNull()
    expect(query(node, ".report-share").textContent).toContain("Copied")
    node.remove()
  })

  it("offers no link for a report that failed to load", async () => {
    window.history.replaceState(null, "", `/r/${expectOk(encodeReportPayload(gistUrl)).payload}`)
    const node = createReportTabsInput({fetchText: async () => { throw new Error("404 Not Found") }})
    document.body.append(node)
    await settle()

    // A link to a report this browser could not read is not worth handing to anyone.
    expect(node.querySelector(".report-share")).toBeNull()
    expect(node.querySelector(".report-source-url")).toBeNull()
    node.remove()
  })

  it("rebuilds the report a shared link names, with no input", async () => {
    // The public form: the token as a path segment, which is what someone is actually handed.
    window.history.replaceState(null, "", `/r/${expectOk(encodeReportPayload(gistUrl)).payload}`)
    const fetchText = vi.fn(async () => logExport)
    const node = createReportTabsInput({fetchText})
    await settle()

    expect(fetchText).toHaveBeenCalledWith(gistUrl)
    expect(node.value.tabs).toHaveLength(1)
    expect(at(node.value.tabs, 0).status).toBe("loaded")
  })

  it("says the link itself is at fault, not that the log is missing", async () => {
    window.location.hash = "#r=!!!not-a-token!!!"
    const fetchText = vi.fn(async () => logExport)
    const node = createReportTabsInput({fetchText})
    await settle()

    // Distinct from a retrieval failure on purpose: nothing was ever fetched, and the reader's only
    // remedy is a fresh link.
    expect(fetchText).not.toHaveBeenCalled()
    expect(panelText(node)).toMatch(/\(broken link: /)
  })

  // /r/<token> is the public form, and a damaged link has no usable form at all. The reader lands on
  // the app root: not the #r= hop, which is an internal detail of the 404 shim, and not /r/<token>
  // either, because an address that resolves to nothing only looks usable.
  it.each([
    ["a token damaged in transit", `${"A".repeat(20)}zz`],
    ["a token mangled beyond a path", "!!!not-a-token!!!"]
  ])("drops %s from the address bar entirely", async (_label, token) => {
    window.location.hash = `#r=${token}`
    const replaceState = vi.spyOn(window.history, "replaceState")
    const node = createReportTabsInput({fetchText: async () => logExport})
    await settle()

    expect(panelText(node)).toMatch(/\(broken link: /)
    expect(replaceState).toHaveBeenCalledWith(null, "", expect.not.stringContaining("#"))
    expect(replaceState).toHaveBeenCalledWith(null, "", expect.not.stringContaining("/r/"))
  })

  it("names the failed link in the message, trimmed", async () => {
    // The token is opaque and cannot be an address, but a reader comparing what they were sent still
    // needs to see which link this was.
    const token = `${expectOk(encodeReportPayload(gistUrl)).payload.slice(0, -2)}zz`
    window.location.hash = `#r=${token}`
    const node = createReportTabsInput({fetchText: async () => logExport})
    await settle()

    expect(panelText(node)).toMatch(/Ask for a fresh link/)
    expect(panelText(node)).toContain(token.slice(-8))
    // Trimmed, not the whole token: the message is an explanation, not a payload dump.
    expect(panelText(node)).not.toContain(token)
  })

  it("sets the broken link as code, apart from the sentence", async () => {
    window.location.hash = `#r=${expectOk(encodeReportPayload(gistUrl)).payload.slice(0, -2)}zz`
    const node = createReportTabsInput({fetchText: async () => logExport})
    await settle()

    // An opaque address set in the body face runs into the prose around it. The reader is matching it
    // against a link they were sent character by character, so it has to be pickable out of the line.
    const link = query(node, ".report-share-error code.report-broken-link")
    expect(link).not.toBeNull()
    expect(must(link, "the share link").textContent).toMatch(/\/r\//)
    // The sentence itself stays plain: the markup is around the link, not the whole notice.
    expect(must(query(node, ".report-share-error").firstChild, "the notice text").nodeType).toBe(3)
  })

  it("reports a log that could not be retrieved as its own failure", async () => {
    window.location.hash = `#r=${expectOk(encodeReportPayload(gistUrl)).payload}`
    const node = createReportTabsInput({fetchText: async () => { throw new Error("404 Not Found") }})
    await settle()

    const tab = at(node.value.tabs, 0)
    expect(tab.status).toBe("error")
    expect(tab.error).toMatch(/404 Not Found/)
    expect(tab.error).not.toMatch(/\(broken link: /)
  })

  it("puts the loaded report in the address bar, without stacking history entries", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState")
    const pushState = vi.spyOn(window.history, "pushState")
    const node = createReportTabsInput({fetchText: async () => logExport})
    document.body.append(node)

    const input = query<HTMLInputElement>(node, "input[type=url]")
    input.value = gistUrl
    input.dispatchEvent(new window.Event("input", {bubbles: true}))
    query(node, "form").dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}))
    await settle()

    expect(replaceState).toHaveBeenCalledWith(null, "", expect.stringContaining("/r/"))
    // Assigning location.hash would push an entry, so loading three reports would take three presses
    // of Back to leave the page.
    expect(pushState).not.toHaveBeenCalled()
    node.remove()
  })

  it("puts no report route in the address bar when a report fails to load", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState")
    const node = createReportTabsInput({fetchText: async () => { throw new Error("404 Not Found") }})
    document.body.append(node)

    const input = query<HTMLInputElement>(node, "input[type=url]")
    input.value = gistUrl
    input.dispatchEvent(new window.Event("input", {bubbles: true}))
    query(node, "form").dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}))
    await settle()

    // A link to a report this browser could not read is not worth handing to anyone.
    expect(replaceState).not.toHaveBeenCalledWith(null, "", expect.stringContaining("/r/"))
    node.remove()
  })

  it("moves the address bar to whichever report is active", async () => {
    const secondUrl = "https://example.com/second-agent-api-log.json"
    const node = createReportTabsInput({fetchText: async () => logExport})
    document.body.append(node)

    const load = async (url: string) => {
      const input = query<HTMLInputElement>(node, "input[type=url]")
      input.value = url
      input.dispatchEvent(new window.Event("input", {bubbles: true}))
      query(node, "form").dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}))
      await settle()
    }

    await load(gistUrl)
    query(node, ".report-add").click()
    await load(secondUrl)
    expect(window.location.pathname).toContain(expectOk(encodeReportPayload(secondUrl)).payload)

    const replaceState = vi.spyOn(window.history, "replaceState")
    at(queryAll(node, ".report-list-button"), 0).click()
    await settle()

    // The address bar names the active report. Leaving it on the second while the first is on screen
    // would hand someone a link to a report they are not looking at.
    expect(replaceState).toHaveBeenCalledWith(null, "", expect.stringContaining(expectOk(encodeReportPayload(gistUrl)).payload))
    node.remove()
  })

  it("clears the report route from the address bar when the report is deleted", async () => {
    window.history.replaceState(null, "", `/r/${expectOk(encodeReportPayload(gistUrl)).payload}`)
    const node = createReportTabsInput({fetchText: async () => logExport})
    document.body.append(node)
    await settle()

    const replaceState = vi.spyOn(window.history, "replaceState")
    query(node, ".report-delete").click()
    await settle()

    // A token left behind after its report is gone is a link to something no longer on screen, and
    // reloading it would bring the deleted report straight back.
    expect(replaceState).toHaveBeenCalledWith(null, "", expect.not.stringContaining("/r/"))
    expect(node.querySelector(".report-share-panel")).toBeNull()
    node.remove()
  })

  it("restores the route to the address bar after opening a shared link", async () => {
    window.location.hash = `#r=${expectOk(encodeReportPayload(gistUrl)).payload}`
    const replaceState = vi.spyOn(window.history, "replaceState")
    createReportTabsInput({fetchText: async () => logExport})
    await settle()

    // The fragment is an implementation detail of the hop through 404.md. What a reader sees after
    // it lands has to be the link they can copy back out, bookmark, or send on.
    expect(replaceState).toHaveBeenCalledWith(null, "", expect.stringContaining("/r/"))
    expect(replaceState).not.toHaveBeenCalledWith(null, "", expect.stringContaining("#"))
  })

  it("also accepts the fragment the 404 shim redirects through", async () => {
    // A static host cannot serve the app at /r/<token>, so 404.md hands the token over this way.
    // Both readers have to work or a shared link dies at the hop.
    window.location.hash = `#r=${expectOk(encodeReportPayload(gistUrl)).payload}`
    const fetchText = vi.fn(async () => logExport)
    createReportTabsInput({fetchText})
    await settle()

    expect(fetchText).toHaveBeenCalledWith(gistUrl)
  })

  it("loads nothing when neither the path nor the fragment names a report", async () => {
    const fetchText = vi.fn(async () => logExport)
    createReportTabsInput({fetchText})
    await settle()

    expect(fetchText).not.toHaveBeenCalled()
  })
})
