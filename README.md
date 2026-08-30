# Tapoo Oracle

Tapoo Oracle is an [Observable Framework](https://observablehq.com/framework/) app for inspecting raw JSON payloads emitted by Tapoo's Agent behavior profiler.

The app is an external analysis companion for Tapoo. Paste profiler JSON into the analyzer and it produces a concise behavior summary, event counts, status/outcome signals, warning counts, backtracking references, timeline plots, and event rows suitable for review.

## Getting started

Install the reviewed dependency graph:

```
make install
```

Start the local preview server:

```
make dev
```

Then visit <http://localhost:3000>.

If you don't already have `pnpm`, enable it with Corepack first:

```
corepack enable pnpm
```

## Tapoo profiler payloads

Tapoo Oracle currently accepts pasted JSON directly in the browser. The parser is intentionally schema-flexible while the Tapoo profiler contract is still settling: it looks for common event, action, status, agent, timestamp, warning, and backtracking fields across nested objects and arrays.

Cold fact: schema-flexible analysis is useful for exploration, but it is not a replacement for a stable profiler contract. Once Tapoo's JSON schema is finalized, add a fixture and tighten the analyzer around the exact field names we want to support long term.

## Project structure

The app source is intentionally small:

```ini
.
├─ src
│  ├─ components
│  │  └─ oracle.js             # Tapoo payload parsing and analysis helpers
│  └─ index.md                 # analyzer page
├─ .gitignore
├─ Makefile
├─ observablehq.config.js      # the app config file
├─ package.json
└─ README.md
```

**`src`** - The Observable source root. Pages go here, and Markdown filenames control routes.

**`src/index.md`** - The Tapoo Oracle analyzer page.

**`src/components/oracle.js`** - Shared parsing, event extraction, summary, and table helpers.

**`observablehq.config.js`** - This is the [app configuration](https://observablehq.com/framework/config) file, such as the pages and sections in the sidebar navigation, and the app’s title.

## Command reference

| Command                       | Description                                      |
| ----------------------------- | ------------------------------------------------ |
| `make help`                   | List the available project commands              |
| `make install`                | Install the reviewed, locked dependencies        |
| `make audit`                  | Fail if the lockfile has known vulnerabilities   |
| `make ci`                     | Run the frozen install, audit, and production build |
| `make dev`                    | Start the local preview server                   |
| `make build`                  | Build the static site, generating `./dist`       |
| `make deploy`                 | Deploy the app to Observable                     |
| `make clean`                  | Clear the local data loader cache                |
| `make observable ARGS="help"` | Run Observable CLI commands                      |

Each target delegates to `pnpm`; use `PNPM=/path/to/pnpm` to override the executable when needed.

## Dependency security

`make install` uses pnpm's frozen lockfile mode, so it installs exactly the reviewed dependency graph. `make audit` checks that graph against the npm advisory database and exits non-zero for low-or-higher severity findings. `make ci` runs the frozen install, audit, and production build in that order.

New dependencies must come from the package registry, and pnpm waits 24 hours after publication before resolving them. The reviewed lockfile includes integrity hashes for downloaded packages; keep it committed and review every change to it.
