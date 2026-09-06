/**
 * @vitest-environment jsdom
 */

import {describe, expect, it} from "vitest"

import {stampBuildAge} from "./build-stamp"

const footer = (html: string): HTMLElement => {
  const root = document.createElement("footer")
  root.innerHTML = html
  document.body.append(root)
  return root
}

const NOW = new Date("2026-09-06T12:00:00Z")

describe("stampBuildAge", () => {
  it("finishes the build stamp with how long ago it was", () => {
    const root = footer('<time datetime="2026-09-03T12:00:00Z" data-build-age>2026-09-03</time>')

    stampBuildAge(root, NOW)

    expect(root.textContent).toBe("2026-09-03 (3 days ago)")
  })

  // A re-render must not stack a second parenthetical onto the first.
  it("replaces the age rather than appending another", () => {
    const root = footer('<time datetime="2026-09-03T12:00:00Z" data-build-age>2026-09-03</time>')

    stampBuildAge(root, NOW)
    stampBuildAge(root, new Date("2026-09-06T13:00:00Z"))

    expect(root.querySelectorAll(".build-age")).toHaveLength(1)
    expect(root.textContent).toBe("2026-09-03 (3 days ago)")
  })

  // A footer decoration must never take the page down with it: the date already in the HTML is true and
  // useful on its own, and everything here is an improvement on that rather than a requirement.
  it("does nothing when there is no stamp to finish", () => {
    const root = footer("<span>no stamp here</span>")

    expect(() => stampBuildAge(root, NOW)).not.toThrow()
    expect(root.textContent).toBe("no stamp here")
  })

  it("does nothing when the stamp carries an unreadable instant", () => {
    const root = footer('<time datetime="the other day" data-build-age>whenever</time>')

    stampBuildAge(root, NOW)

    expect(root.textContent).toBe("whenever")
  })
})
