// Shared plumbing for vendoring Tapoo's analysis contract into this app.
//
// Tapoo Oracle renders the same behavior rubric that `make agentic-analysis` prints in the Tapoo
// repository. Both must answer identically, so the rubric is not reimplemented here - it is copied
// in verbatim from tapoo/analysis/ and pinned by content hash.
//
// The copy is checked into git on purpose. A submodule or a git dependency would keep one copy, but
// it would also mean the Observable build cannot run from a plain clone. Vendoring keeps the build
// self-contained; check-vendor-drift.mjs is what stops the copy from quietly aging.

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// UPSTREAM_REPO is the source of truth for everything in VENDORED_FILES.
export const UPSTREAM_REPO = "https://github.com/dmigwi/tapoo.git"

// UPSTREAM_DIR is where the contract lives inside that repository.
export const UPSTREAM_DIR = "analysis"

// VENDORED_FILES maps each upstream file to the name it takes here.
//
// The .mjs -> .js rename is not cosmetic. Observable Framework resolves a relative .js import into a
// module it copies into the bundle, but silently ignores a .mjs one: the build still succeeds, the
// emitted page still imports the path, and the file is simply never there. That failure surfaces
// only as a blank page in a browser, so the rename happens here, deterministically, rather than
// being left as a trap for whoever next runs the vendor script.
export const VENDORED_FILES = {
  "log-contract.mjs": "log-contract.js",
  "rubric-engine.mjs": "rubric-engine.js",
  "fixtures/sample-agent-api-log.json": "fixtures/sample-agent-api-log.json",
}

// VENDOR_DIR is where the copy lands, inside the Observable source root so the app can import it.
export const VENDOR_DIR = "src/vendor/tapoo-analysis"

// VENDOR_MANIFEST records which upstream commit the copy came from, and both hashes for every file:
// the upstream original, which is the provenance claim, and the adapted copy, which is what detects
// a hand edit without needing the network.
export const VENDOR_MANIFEST = join(VENDOR_DIR, "VENDOR.json")

// adaptForBundler applies the rename to the import statements inside a vendored module, so a module
// that imports its sibling still resolves after both have been renamed. It is a pure function of the
// contents, which is what lets the drift check re-derive the expected copy from upstream rather than
// trusting that the last vendor run did the same thing.
export function adaptForBundler(contents) {
  return contents.replace(/(from\s+")(\.[^"]*)\.mjs(")/g, "$1$2.js$3")
}

export const hashOf = (contents) => createHash("sha256").update(contents).digest("hex")

// resolveSource returns a directory containing the upstream repository, plus how it was obtained.
//
// A local checkout is preferred when one is offered, because the contract and its consumer are
// routinely changed together: requiring a push before the Oracle can see a contract change would
// make that loop useless. CI passes no local path and therefore always clones.
export function resolveSource({ from, ref = "master" } = {}) {
  if (from) {
    const commit = execFileSync("git", ["-C", from, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    const status = execFileSync("git", ["-C", from, "status", "--porcelain"], { encoding: "utf8" })
    const branch = execFileSync("git", ["-C", from, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim()

    return { dir: from, commit, ref: branch, dirty: status.trim().length > 0, cleanup: () => {} }
  }

  const dir = mkdtempSync(join(tmpdir(), "tapoo-upstream-"))
  execFileSync("git", ["clone", "--depth", "1", "--branch", ref, UPSTREAM_REPO, dir], {
    stdio: "pipe",
  })
  const commit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()

  return { dir, commit, ref, dirty: false, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// readUpstream returns the current upstream contents of every vendored file, keyed by upstream name.
export function readUpstream(sourceDir) {
  return Object.fromEntries(
    Object.keys(VENDORED_FILES).map((name) => [
      name,
      readFileSync(join(sourceDir, UPSTREAM_DIR, name), "utf8"),
    ]),
  )
}
