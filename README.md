# Tapoo Oracle

[![CI](https://github.com/dmigwi/tapoo-oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/dmigwi/tapoo-oracle/actions/workflows/ci.yml)
[![Page Deployment](https://github.com/dmigwi/tapoo-oracle/actions/workflows/pages.yml/badge.svg)](https://github.com/dmigwi/tapoo-oracle/actions/workflows/pages.yml)

Tapoo Oracle is the analytics extension of [Tapoo](https://github.com/dmigwi/tapoo). It is an
[Observable Framework](https://observablehq.com/framework/) app that reads a downloaded Tapoo
`agent-api` gameplay log and reports the agent's behavior profile against the
[Tapoo Agentic Behavior Rubric](docs/TAPOO_AGENTIC_BEHAVIOR_RUBRIC.md).

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
│  ├─ TAPOO_AGENTIC_BEHAVIOR_RUBRIC.md        # the rubric both front ends answer
│  └─ TAPOO_AGENTIC_BEHAVIOR_RUBRIC_NOTES.md  # why each group is worded as it is
├─ scripts
│  ├─ hooks/pre-commit      # lint and tests
│  └─ agentic-analysis.mjs  # terminal front end
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

**`src/analysis/`** is the analysis itself, and the only copy of it. Both front ends call
it, so a change here changes what the terminal report and this app both answer.

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
| `make build` | Build the static site into `./dist` |
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

- Node.js `22`
- `pnpm` as pinned by `packageManager` in `package.json`

The pnpm patch version is allowed to differ from Tapoo's; each repository pins whatever generated its
own lockfile. What is standardized across both is the discipline — frozen-lockfile installs, an audit
gate, Node 22, and the same CI shape.

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
