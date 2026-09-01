# Tapoo Oracle

[![CI](https://github.com/dmigwi/tapoo-oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/dmigwi/tapoo-oracle/actions/workflows/ci.yml)
[![Page Deployment](https://github.com/dmigwi/tapoo-oracle/actions/workflows/pages.yml/badge.svg)](https://github.com/dmigwi/tapoo-oracle/actions/workflows/pages.yml)

Tapoo Oracle is the analytics extension of [Tapoo](https://github.com/dmigwi/tapoo). It is an
[Observable Framework](https://observablehq.com/framework/) app that reads a downloaded Tapoo
`agent-api` gameplay log and reports the agent's behavior profile against fact questions defined by
the rubric engine and displayed directly beside their answers in the report.

The profile is a factual reasoning record, not a scorecard. Nine capability groups (`C1`–`C9`) and
six violation groups (`V1`–`V6`) are each answered strictly YES or NO from logged evidence, reported
as separate fractions, and never combined into a single intelligence score. A NO means the behavior
was **not observed in this sample** — never that the model is incapable of it.

## Relationship to Tapoo

Tapoo produces the logs. This repository owns everything that reads them: the rubric, the log
contract, the engine that answers one against the other, and both front ends.

| Front end | Where |
| --- | --- |
| Terminal report | `make agentic-analysis LOGS="a.json"` here |
| This app | Visual profile |

The engine lives in [`src/analysis/`](src/analysis) and the app calls it. This matters because the
rubric issues strict verdicts about a model's behavior, so two implementations would eventually
disagree about the same log with nothing revealing which one was wrong.

**Known gap:** `scripts/agentic-analysis.mjs` still carries its own copy of the rubric logic rather
than importing that engine, so the two front ends are two implementations today. This was previously
masked by vendoring the engine from Tapoo and failing CI on a content-hash drift check - a check that
could only ever report divergence between the two copies of the *library*, never between the library
and the CLI beside it. Both now live here, which is what makes collapsing them into one call
possible; until that is done, treat the app as the reference answer.

## Getting started

```bash
corepack enable pnpm
```

```bash
make install
```

```bash
make dev
```

Then visit <http://localhost:3000>. The page loads a bundled reference log so it is never empty;
drop in your own export to replace it.

## Supplying a log

In Tapoo's browser SPA, run an `agent-api` round and download the log from the Logs panel. It arrives
as `tapoo-v<version>-agent-api-logs-<epoch>.json`. Load that file on the Oracle's page, or paste its
contents.

The export is an envelope written by `tapooDownloadLogs`:

```json
{
  "name": "tapoo",
  "version": "2.5.0",
  "mode": "agent-api",
  "downloadedAt": "2026-08-30T21-00-00+02-00",
  "entries": [{"epochMs": 0, "time": "…", "turn": 1, "level": 1, "game": 1, "log": "info", "payload": "Agent request.", "details": {}}]
}
```

Input that is not a Tapoo export is rejected with a reason rather than analyzed. The contract is
fixed and validated — the analyzer does not guess at field names, and every number it displays traces
to a rubric answer or an explicitly logged event.

### Privacy

Downloaded logs never contain an agent's credential or extra headers; a regression test in Tapoo's
`frontend/app/agent/request.test.ts` guards that. Analysis happens entirely in your browser — nothing
is uploaded.

## Project structure

```ini
.
├─ .github/workflows        # CI and manual Pages deployment
├─ docs
│  └─ TAPOO_AGENTIC_BEHAVIOR_RUBRIC_NOTES.md  # evaluator implementation notes
├─ scripts
│  ├─ hooks/pre-commit      # lint and tests
│  ├─ agentic-analysis.mjs  # terminal front end
│  ├─ build-root.mjs        # where the stripped build root lives
│  └─ build.mjs             # stages and strips sources for the build
├─ src
│  ├─ components
│  │  └─ oracle.js          # adapter: engine results → cards, rows, sentences
│  ├─ analysis              # log contract and rubric engine — the only analysis implementation
│  └─ index.md              # analyzer page
├─ Makefile
├─ observablehq.config.js
└─ package.json
```

**`src/components/oracle.js`** holds no analysis of its own. It turns one engine result into
presentation, and is the only place to change how a profile is displayed.

**`src/analysis/`** is the analysis itself. The rubric engine keeps each fact-question definition
beside its evaluator and returns both to the app, so the visible wording cannot drift from the
question that was answered.

## Build

```bash
make build
```

The build is a chained sequence, spelled out in `package.json` so neither half is hidden:

```
trap 'rimraf .tmp/build-root' EXIT; node ./scripts/build.mjs && ORACLE_STRIPPED_BUILD=1 observable build
```

`scripts/build.mjs` stages a copy of `src/` under `.tmp/build-root` and strips every `.js` in that
copy with esbuild. Observable then templates the site from that staged root into `./public`.

The staged root is removed by an `EXIT` trap, so it is cleaned up whether the build succeeds or fails
— including when the strip step itself rejects a malformed source. The trap does not swallow the exit
status: a failed build still exits non-zero, so CI fails rather than passing on a half-finished
artifact.

The modules in this app are heavily commented on purpose — the rubric issues strict verdicts about a
model's behavior, so the reasoning behind each answer belongs next to the code. That reasoning is for
readers of the repository, not for browsers downloading the page, where it is inert payload. Stripping
takes the emitted modules from **85 kB to 35 kB**.

Stripping happens before Observable runs rather than over the built output, and the order matters:
Observable fingerprints each emitted module by content hash. Minifying afterwards would leave every
filename describing bytes that are no longer being served.

`src/` is never modified, and the staged copy never outlives the build that created it. To inspect the
stripped output, run the staging step on its own — it leaves `.tmp/build-root` in place:

```bash
node ./scripts/build.mjs
```

An interrupt (Ctrl-C) may terminate the shell before the trap runs. That is harmless: `.tmp/` is
ignored by git, and `scripts/build.mjs` wipes the staged root at the start of every run.

Running the Observable CLI by hand is refused. `observable build` and `observable deploy` both publish
an artifact, so `observablehq.config.js` rejects either one unless `scripts/build.mjs` has already
staged the stripped root:

```
Refusing to build directly from the observable CLI.
Run `pnpm run build` (or `pnpm run deploy`), which strips the sources first.
```

Without that guard, the two steps are only chained by convention, and a bare `observable build` would
quietly publish every source comment. `observable preview` is deliberately not covered: `make dev`
serves the real, commented source and publishes nothing.

The chained scripts use POSIX shell syntax — an inline environment variable and `trap`. CI runs on
Ubuntu and development is on macOS/Linux; building on Windows would need `cross-env` and a different
cleanup mechanism.

## Command reference

| Command | Description |
| --- | --- |
| `make help` | List the available project commands |
| `make install` | Install the reviewed, locked dependencies |
| `make audit` | Fail if the lockfile has known vulnerabilities |
| `make agentic-analysis` | Answer the rubric for exported logs (`LOGS="a.json b.json"`) |
| `make lint` | Run eslint |
| `make test` | Run the test suite |
| `make coverage` | Run the test suite with coverage |
| `make quality` | Lint and tests |
| `make ci` | Run the local equivalent of the CI pipeline |
| `make dev` | Start the local preview server |
| `make build` | Strip the sources, build the static site into `./public`, then clean up |
| `make clean` | Clear the local data loader cache |

Each target delegates to `pnpm`; use `PNPM=/path/to/pnpm` to override the executable.

## Contributing

Install the repository git hooks before creating commits:

```bash
./scripts/install-hooks.sh
```

The hook runs eslint and the test suite. Before opening a PR:

```bash
make ci
```

### Toolchain

- Node.js `24` LTS
- pnpm `11.25.0`, as pinned by `packageManager` in `package.json`

Tapoo and Tapoo Oracle intentionally share the same Node.js and pnpm versions, frozen-lockfile
installs, dependency audit gate, and CI runtime setup.

## Dependency security

`make install` uses pnpm's frozen lockfile mode, so it installs exactly the reviewed dependency graph.
`make audit` checks that graph against the npm advisory database and exits non-zero for low-or-higher
severity findings.

New dependencies must come from the package registry, and pnpm waits 24 hours after publication
before resolving them. The reviewed lockfile includes integrity hashes; keep it committed and review
every change to it.

## License

Apache License 2.0. See [LICENSE](LICENSE). Distributed on an `AS IS` basis, without warranties or
guaranteed support.
