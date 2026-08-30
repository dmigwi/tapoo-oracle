// Copies Tapoo's analysis contract into src/vendor/tapoo-analysis and records where it came from.
//
//   node scripts/vendor-analysis.mjs                     # from the published master branch
//   node scripts/vendor-analysis.mjs --from ../tapoo     # from a local Tapoo checkout
//   node scripts/vendor-analysis.mjs --ref some-branch   # from another upstream branch
//
// Run this whenever tapoo/analysis changes. check-vendor-drift.mjs is what tells you that you need
// to, so this is never a step anyone has to remember on their own.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import {
  UPSTREAM_DIR,
  UPSTREAM_REPO,
  VENDORED_FILES,
  VENDOR_DIR,
  VENDOR_MANIFEST,
  adaptForBundler,
  hashOf,
  readUpstream,
  resolveSource,
} from "./vendor-lib.mjs"

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--from") {
      options.from = argv[index + 1]
      index += 1
    } else if (argv[index] === "--ref") {
      options.ref = argv[index + 1]
      index += 1
    } else {
      console.error(`unknown argument: ${argv[index]}`)
      process.exit(1)
    }
  }

  return options
}

const options = parseArgs(process.argv.slice(2))
const source = resolveSource(options)

try {
  const upstream = readUpstream(source.dir)

  for (const [name, vendoredName] of Object.entries(VENDORED_FILES)) {
    const destination = join(VENDOR_DIR, vendoredName)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, adaptForBundler(upstream[name]))
  }

  const manifest = {
    repository: UPSTREAM_REPO,
    directory: UPSTREAM_DIR,
    ref: source.ref,
    commit: source.commit,
    // A copy taken from a dirty working tree cannot be reproduced from its commit alone. Recording
    // it keeps that visible rather than letting the manifest imply a provenance it does not have.
    dirtySource: source.dirty,
    vendoredAt: new Date().toISOString(),
    // Two hashes per file, because they answer different questions. `upstream` is the provenance
    // claim - what the original looked like at that commit. `vendored` is what the copy in this repo
    // should still hash to, which is how a local hand edit is caught with no network access.
    files: Object.fromEntries(
      Object.entries(VENDORED_FILES).map(([name, vendoredName]) => [
        name,
        {
          vendoredAs: vendoredName,
          upstream: `sha256:${hashOf(upstream[name])}`,
          vendored: `sha256:${hashOf(adaptForBundler(upstream[name]))}`,
        },
      ]),
    ),
  }

  writeFileSync(VENDOR_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`Vendored ${Object.keys(VENDORED_FILES).length} files from ${source.ref} @ ${source.commit.slice(0, 8)}`)
  if (source.dirty) {
    console.warn("warning: the source checkout had uncommitted changes; re-vendor once they land.")
  }
} finally {
  source.cleanup()
}
