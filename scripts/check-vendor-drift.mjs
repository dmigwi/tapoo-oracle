// Fails when the vendored copy of Tapoo's analysis contract no longer matches upstream.
//
//   node scripts/check-vendor-drift.mjs                  # against the published master branch
//   node scripts/check-vendor-drift.mjs --from ../tapoo  # against a local Tapoo checkout
//   node scripts/check-vendor-drift.mjs --offline        # manifest hashes only, no network
//
// This is the reason vendoring is safe here. Without it, the copy in src/vendor is a fork that looks
// like a dependency: the Oracle would keep answering the rubric the way Tapoo used to, and every
// output would still look authoritative. The check runs in CI so that divergence is a red build
// rather than a discrepancy someone notices months later in a report.

import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  VENDORED_FILES,
  VENDOR_DIR,
  VENDOR_MANIFEST,
  adaptForBundler,
  hashOf,
  readUpstream,
  resolveSource,
} from "./vendor-lib.mjs"

function parseArgs(argv) {
  const options = { offline: false }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--from") {
      options.from = argv[index + 1]
      index += 1
    } else if (argv[index] === "--ref") {
      options.ref = argv[index + 1]
      index += 1
    } else if (argv[index] === "--offline") {
      options.offline = true
    } else {
      console.error(`unknown argument: ${argv[index]}`)
      process.exit(1)
    }
  }

  return options
}

const options = parseArgs(process.argv.slice(2))

let manifest
try {
  manifest = JSON.parse(readFileSync(VENDOR_MANIFEST, "utf8"))
} catch (error) {
  console.error(`Cannot read ${VENDOR_MANIFEST}: ${error.message}`)
  console.error("Run: pnpm run vendor:analysis")
  process.exit(1)
}

const problems = []

// Stage one: does the checked-in copy still match its own manifest? This catches a hand edit to the
// vendored files, needs no network, and is the failure most likely to happen by accident.
const local = {}
for (const [name, vendoredName] of Object.entries(VENDORED_FILES)) {
  let contents
  try {
    contents = readFileSync(join(VENDOR_DIR, vendoredName), "utf8")
  } catch {
    problems.push(`${vendoredName}: missing from ${VENDOR_DIR}`)
    continue
  }

  local[name] = contents
  const expected = manifest.files?.[name]?.vendored
  const actual = `sha256:${hashOf(contents)}`
  if (expected !== actual) {
    problems.push(`${vendoredName}: edited locally - does not match the hash recorded in VENDOR.json`)
  }
}

// Stage two: has upstream moved on? Only this stage needs the network, so it is skippable for local
// runs while the manifest check above always runs.
if (!options.offline && problems.length === 0) {
  const source = resolveSource(options)
  try {
    const upstream = readUpstream(source.dir)
    for (const name of Object.keys(VENDORED_FILES)) {
      // Compared after the same rename the vendor script applies, so the check measures a real
      // upstream change rather than re-reporting the adaptation as drift on every run.
      if (adaptForBundler(upstream[name]) !== local[name]) {
        problems.push(`${name}: upstream changed at ${source.ref} @ ${source.commit.slice(0, 8)}`)
      }
    }
  } finally {
    source.cleanup()
  }
}

if (problems.length > 0) {
  console.error("Vendored Tapoo analysis contract is out of date:\n")
  for (const problem of problems) {
    console.error(`  - ${problem}`)
  }
  console.error("\nRe-vendor with: pnpm run vendor:analysis")
  console.error("See docs/VENDORING.md for how, and for what to review afterwards.")
  process.exit(1)
}

const scope = options.offline ? "manifest hashes" : `upstream ${manifest.ref}`
console.log(`Vendored Tapoo analysis contract is current (${scope}).`)
