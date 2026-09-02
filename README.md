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
├─ scripts                  # CLI, hooks, and the bundling build
├─ src
│  ├─ app.ts                # The single entry the page imports
│  ├─ lib                   # Contracts, rubric engine, adapters, and views
│  │  └─ _snapshot_         # Vendored test payloads; never production input
│  ├─ index.md              # Observable page
│  └─ oracle.css            # App styles
├─ staged                   # Generated: the root Observable builds and previews from
├─ Makefile
├─ observablehq.config.js
└─ package.json
```

`src/lib/log-contract.ts` validates Tapoo JSON, `share-link.ts` handles remote URLs and share tokens,
`maze.ts` decodes mazes, and `rubric-engine.ts` performs analysis. `report-adapters.ts` prepares the
validated results for the views. `staged/` is generated and gitignored.

## Commands

| Command | Description |
| --- | --- |
| `make install` | Install locked dependencies |
| `make audit` | Run pnpm vulnerability audit |
| `make lint` | Run eslint |
| `make test` | Run Vitest |
| `make quality` | Run type checking, lint, and tests |
| `make ci` | Run install, audit, lint, tests, and build |
| `make dev` | Start Observable preview |
| `make build` | Build the stripped static site into `./public` |
| `make serve` | Serve `./public`; `/r/*` is rewritten to the app with status 200 |
| `make deploy` | Build, post-process, and deploy the finished output to Observable |
| `make agentic-analysis LOGS="a.json"` | Run the terminal report |

### Deploying under a path

Set `ORACLE_SITE_BASE` when the site is not served from a domain root — a GitHub Pages project site
lives under `/<repo>/`:

```bash
ORACLE_SITE_BASE=/tapoo-oracle/ pnpm run build
```

Hosts with rewrite support should serve `index.html` for `/r/*` with status 200. GitHub Pages has no
rewrite rules, so its custom `404.html` performs a JavaScript redirect; report links work in browsers
but return 404 to clients that do not execute JavaScript.

## Privacy

Log contents are analyzed in the browser. Downloads time out after 20 seconds and stop at 25 MiB.

Share tokens are reversible and are sent in the `/r/<token>` request path, so the source URL can appear
in host logs and browser history. Never put credentials directly in a URL. Do not use Gist for
proprietary data: secret gists are unlisted, not private. Sensitive reports need authenticated storage,
CORS, short-lived signed access, retention limits, and a deployment whose request-log policy is trusted.

## Toolchain

- Node.js `24`
- pnpm `11.25.0`

## License

Apache License 2.0. See [LICENSE](LICENSE).
