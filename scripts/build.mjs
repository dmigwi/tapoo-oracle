// Builds the site from a stripped copy of the source root.
//
//   node scripts/build.mjs
//
// This only stages and strips. `pnpm run build` chains it with `observable build`, so neither half
// is a complete build on its own and both are visible in one place.
//
// Every module Observable copies into the output keeps its source comments verbatim, and this app's
// modules are heavily commented on purpose - the rubric semantics are only defensible if the
// reasoning sits next to the code. That reasoning is for readers of the repository, not for browsers
// downloading the page, where it is inert payload.
//
// The strip happens *before* Observable runs rather than over the built output, which matters for
// more than tidiness: Observable fingerprints each emitted module by content hash. Minifying
// afterwards would leave every filename describing bytes that are no longer being served. Staging
// first means the hashes describe what actually ships.
//
// src/ is never modified. The staged copy is rebuilt from scratch each run and removed once the build
// succeeds, so a failed build can never leave stripped sources behind.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

import * as esbuild from "esbuild"

import { STAGED_ROOT } from "./build-root.mjs"

const SOURCE_ROOT = "src"

// The Observable cache holds resolved npm modules. The staged root gets a symlink to the real one
// rather than a copy, so a stripped build reuses the same warm cache as `observable preview` instead
// of re-resolving the dependency graph over the network on every run.
const CACHE_DIR = ".observablehq"

// Tests are never imported by a page, so Observable would not emit them anyway. Excluding them keeps
// the staged root to just the files that can reach the output.
//
// Only test modules and the cache are ever excluded. Assets are not JavaScript and are never stripped
// or filtered - a component resolving ../images/foo.svg has to find it under the staged root at the
// same relative path it occupies under src, or Observable emits a page referencing a file it never
// copied. STAGED_ASSET_DIRS below turns that from an incidental consequence of copying all of src into
// something this script actually checks.
const isExcluded = (path) => path.endsWith(".test.js") || path.split(/[\\/]/).includes(CACHE_DIR)

// STAGED_ASSET_DIRS are directories under src that must arrive in the staged root intact. Listing them
// is what makes a future change to isExcluded fail here rather than silently ship a page with missing
// images.
const STAGED_ASSET_DIRS = ["images"]

function filesIn(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...filesIn(path))
    } else if (entry.isFile()) {
      found.push(path)
    }
  }

  return found
}

// verifyStagedAssets fails the build when an asset directory did not survive staging.
//
// It compares by relative path, not by count: a file copied to the wrong place would keep the count
// right while still breaking every reference to it.
function verifyStagedAssets() {
  for (const name of STAGED_ASSET_DIRS) {
    const source = join(SOURCE_ROOT, name)
    if (!existsSync(source)) {
      continue
    }

    const expected = filesIn(source).map((path) => relative(SOURCE_ROOT, path))
    const missing = expected.filter((path) => !existsSync(join(STAGED_ROOT, path)))
    if (missing.length > 0) {
      throw new Error(
        `Assets missing from the staged root: ${missing.join(", ")}.\n` +
          "Components resolve these by relative path, so the build would emit references to files it never copied."
      )
    }
  }
}

const jsFilesIn = (directory) => filesIn(directory).filter((path) => path.endsWith(".js"))

rmSync(STAGED_ROOT, { recursive: true, force: true })
mkdirSync(dirname(STAGED_ROOT), { recursive: true })
cpSync(SOURCE_ROOT, STAGED_ROOT, { recursive: true, filter: (source) => !isExcluded(source) })

verifyStagedAssets()

const realCache = resolve(SOURCE_ROOT, CACHE_DIR)
if (existsSync(realCache)) {
  symlinkSync(realCache, join(STAGED_ROOT, CACHE_DIR), "dir")
}

let before = 0
let after = 0
const stripped = []

for (const path of jsFilesIn(STAGED_ROOT)) {
  const original = readFileSync(path, "utf8")

  // A syntax error here is a real defect in a source file, not a reason to ship it unstripped:
  // failing loudly is what keeps a broken module from reaching the output looking healthy.
  const result = await esbuild.transform(original, {
    loader: "js",
    format: "esm",
    // esnext, so this step only removes - it never downlevels syntax Observable already accepts.
    target: "esnext",
    minify: true,
    legalComments: "none",
  })

  writeFileSync(path, result.code)
  before += Buffer.byteLength(original)
  after += Buffer.byteLength(result.code)
  stripped.push(relative(STAGED_ROOT, path))
}

const percent = before > 0 ? Math.round(((before - after) / before) * 100) : 0
console.log(
  `Stripped ${stripped.length} module${stripped.length === 1 ? "" : "s"}: ` +
    `${(before / 1024).toFixed(1)} kB → ${(after / 1024).toFixed(1)} kB (-${percent}%)`,
)
for (const name of stripped) {
  console.log(`  ${name}`)
}
console.log()
