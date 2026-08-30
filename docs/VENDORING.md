# Vendoring the Tapoo analysis contract

`src/vendor/tapoo-analysis/` is **not this repository's code.** It is copied verbatim from
[`analysis/`](https://github.com/dmigwi/tapoo/tree/master/analysis) in the Tapoo repository and
pinned by content hash in `VENDOR.json`. Do not edit those files.

| Vendored file | What it owns |
| --- | --- |
| `log-contract.js` | The agent-api log envelope, entry shape, and event vocabulary |
| `rubric-engine.js` | The C1–C9 / V1–V6 rubric implementation |
| `fixtures/sample-agent-api-log.json` | Reference export used by the offline preview and the tests |

## Why a copy rather than a dependency

Tapoo Oracle and Tapoo's own `make agentic-analysis` must answer the rubric identically. The rubric
returns strict `YES`/`NO` verdicts about a model's observed behavior, so two implementations would
eventually disagree about the same log — with nothing in either output revealing which one was wrong.

A checked-in copy is used rather than a submodule or a git dependency so a plain `git clone` of this
repository builds without reaching for another one. The tradeoff — a copy quietly aging into a fork —
is what [`scripts/check-vendor-drift.mjs`](../scripts/check-vendor-drift.mjs) exists to prevent, and
it runs in CI on every push.

## The `.mjs` → `.js` rename

Upstream names these modules `.mjs`. They are vendored as `.js`, with their internal sibling imports
rewritten to match.

This is not cosmetic. Observable Framework resolves a relative `.js` import into a module it copies
into the bundle, but silently ignores a `.mjs` one: the build still reports success, the emitted page
still imports the path, and the file is simply never emitted. The result is a page that fails only in
a browser. The rename is applied deterministically by `adaptForBundler` in
[`scripts/vendor-lib.mjs`](../scripts/vendor-lib.mjs), and the drift check applies the same function
to upstream before comparing, so the adaptation is never mistaken for drift.

`VENDOR.json` therefore records two hashes per file: `upstream` is the provenance claim, `vendored`
is what the local copy must still hash to.

## Updating

```bash
pnpm run vendor:analysis
```

```bash
pnpm run vendor:analysis -- --from ../tapoo
```

The first form clones published `master`. The second reads a local Tapoo checkout, which is what you
want while a contract change is still in flight — the contract and its consumer are routinely changed
together, and requiring a push first would make that loop useless.

Commit the changed files together with the regenerated `VENDOR.json`.

A `dirtySource: true` in the manifest means the copy was taken from a checkout with uncommitted
changes and cannot be reproduced from its recorded commit. Re-vendor once the upstream change lands.

## Checking

```bash
pnpm run check:vendor -- --offline
```

```bash
pnpm run check:vendor
```

Offline compares the working copy against the manifest hashes, which catches a hand edit. The plain
form additionally clones upstream and compares against it, which catches upstream having moved on.

## If the check fails

It is telling you the analysis this app performs is no longer the analysis Tapoo performs. Re-vendor;
do not silence the check. If the upstream change alters what a rubric group *means*, then
[`src/components/oracle.js`](../src/components/oracle.js) and the page rendering those groups need
reviewing too — the drift check verifies the code matches, not that the presentation still makes
sense.
