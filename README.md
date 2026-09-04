# Tapoo Oracle

[![TypeScript Version](https://img.shields.io/badge/TypeScript-6.0.3+-blue.svg)](http://www.typescriptlang.org/)
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
| `make audit` | Scan the lockfile for known vulnerabilities via OSV Scanner |
| `make lint` | Run eslint |
| `make test` | Run Vitest |
| `make quality` | Run type checking, lint, and tests |
| `make ci` | Run install, audit, lint, tests, and build |
| `make dev` | Start Observable preview |
| `make build` | Build the stripped static site into `./public` |
| `make serve` | Serve `./public`; `/r/*` is rewritten to the app with status 200 |
| `make deploy` | Build, post-process, and deploy the finished output to Observable |
| `make agentic-analysis LOGS="a.json"` | Run the terminal report |
| `make docker-build` | Build the Docker image |
| `make docker-run` | Build and serve the app in a container on port 3000 |
| `make docker-shell` | Open an interactive shell inside the container |

## Docker

Requires [Docker](https://docs.docker.com/get-docker/) or a compatible runtime (e.g. [Colima](https://github.com/abiosoft/colima)).

**Build the image:**

```bash
make docker-build
```

**Serve on <http://localhost:3000>:**

```bash
make docker-run
```

The image runs `pnpm build` at image-build time and serves the pre-built static site. Re-run `make docker-build` after source changes.

**Open an interactive shell:**

```bash
make docker-shell
```

The shell mounts the project root and a named `node_modules` volume, so edits on the host are visible inside the container without reinstalling dependencies.

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
- [OSV Scanner](https://github.com/google/osv-scanner) — required locally for `make audit` (`brew install osv-scanner`)

## License

Apache License 2.0. See [LICENSE](LICENSE).
