# Tapoo Oracle

[![CI](https://github.com/dmigwi/tapoo-oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/dmigwi/tapoo-oracle/actions/workflows/ci.yml)
[![Page Deployment](https://github.com/dmigwi/tapoo-oracle/actions/workflows/pages.yml/badge.svg)](https://github.com/dmigwi/tapoo-oracle/actions/workflows/pages.yml)

Tapoo Oracle is the analytics extension of [Tapoo](https://github.com/dmigwi/tapoo). It is an
[Observable Framework](https://observablehq.com/framework/) app that reads Tapoo `agent-api` gameplay
logs and reports agent behavior against the Tapoo Agentic Behavior Rubric.

## Run

```bash
corepack enable pnpm
make install
make dev
```

Then open <http://localhost:3000>.

## Input

Tapoo Oracle accepts Tapoo log exports shaped like:

```json
{
  "name": "tapoo",
  "version": "2.5.0",
  "mode": "agent-api",
  "downloadedAt": "2026-08-30T21-00-00+02-00",
  "entries": []
}
```

Input that is not a Tapoo export is rejected. The analyzer does not guess at unknown field names.

## Structure

```ini
.
├─ scripts                  # CLI, hooks, and stripped-build helpers
├─ src
│  ├─ contracts             # Tapoo log, URL/share-token, loading, and maze decoding contracts
│  ├─ analysis              # Rubric engine and behavior analysis
│  ├─ components            # UI adapters, report tables, sharing UI, and maze replay
│  ├─ index.md              # Observable page
│  └─ oracle.css            # App styles
├─ Makefile
├─ observablehq.config.js
└─ package.json
```

`src/contracts/log-contract.js` is the ingress boundary. It validates online JSON URLs, encodes and
decodes share tokens, downloads referenced logs, parses raw JSON text, and returns the normalized Tapoo
log source.

`src/contracts/maze.js` owns Tapoo's encoded-maze format. `src/analysis/rubric-engine.js` owns behavior
analysis. `src/components/oracle.js` adapts validated contract output and rubric results into UI state.

## Commands

| Command | Description |
| --- | --- |
| `make install` | Install locked dependencies |
| `make audit` | Run pnpm vulnerability audit |
| `make lint` | Run eslint |
| `make test` | Run Vitest |
| `make quality` | Run lint and tests |
| `make ci` | Run install, audit, lint, tests, and build |
| `make dev` | Start Observable preview |
| `make build` | Build the stripped static site into `./public` |
| `make agentic-analysis LOGS="a.json"` | Run the terminal report |

## Privacy

Log contents are analyzed in the browser. Shared report links encode the log URL, not the log contents.
The token is reversible, so access control must live where the JSON file is hosted.

## Toolchain

- Node.js `24`
- pnpm `11.25.0`

## License

Apache License 2.0. See [LICENSE](LICENSE).
