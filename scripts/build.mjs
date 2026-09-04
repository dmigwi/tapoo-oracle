// Bundles the app and stages a source root for Observable to read.
//
//   node scripts/build.mjs            one-shot, minified   (chained by `pnpm run build`)
//   node scripts/build.mjs --watch    rebuild + preview    (`pnpm run dev`)
//
// Observable is handed a *staged* root rather than src, and in both modes. That is a stronger claim
// than the previous build made, so it is worth stating why.
//
// The modules are TypeScript, and their import specifiers are extensionless. Observable resolves
// import specifiers itself, and its resolver rejects an extensionless path outright - `findModule`
// throws `empty extension`. So the module graph under src/lib is not something Observable can serve;
// only the bundle is. Bundling in dev as well as in build is what keeps that from being a difference
// between the two - a build-only bundle would leave `make dev` resolving a graph the build never
// exercises, and the failure has no diagnostic.
//
// Bundling also subsumes the old per-file strip. These modules are heavily commented on purpose - the
// rubric semantics are only defensible with the reasoning next to the code - but that reasoning is for
// readers of the repository, not for browsers. A bundle drops it along with the module boundaries,
// and unlike a per-file strip it can tree-shake and rename across them.
//
// Staging before Observable runs (rather than minifying its output) matters for more than tidiness:
// Observable fingerprints each emitted module by content hash. Minifying afterwards would leave every
// filename describing bytes that are no longer served.
//
// src/ is never modified.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { spawn } from "node:child_process"

import * as esbuild from "esbuild"

import { SITE_BASE_ENV, STAGED_ROOT, STRIPPED_BUILD_ENV } from "./build-root.mjs"

const SOURCE_ROOT = "src"

// The single entry. Everything the page uses reaches the bundle through it, which is also what lets
// src/index.md name one specifier instead of tracking the module layout.
const ENTRY = join(SOURCE_ROOT, "app.ts")
const BUNDLE = join(STAGED_ROOT, "app.js")

// The Observable cache holds resolved npm modules. The staged root gets a symlink to the real one
// rather than a copy, so a staged run reuses the same warm cache instead of re-resolving the
// dependency graph over the network every time.
const CACHE_DIR = ".observablehq"

// Page content Observable reads directly. `app.js` is absent on purpose: it is generated, not copied.
const CONTENT = ["index.md", "404.md", "oracle.css", "images"]

// Asset directories that must arrive intact. A component resolving ../images/foo.svg has to find it
// under the staged root at the same relative path it occupies under src, or Observable emits a page
// referencing a file it never copied. Listing them is what makes a future change to CONTENT fail here
// rather than silently ship a page with missing images.
const STAGED_ASSET_DIRS = ["images"]

const watching = process.argv.includes("--watch")

// --finish runs *after* `observable build`, which is the only time public/404.html exists. The staging
// half of this script has to run before it, so the two halves are the same file under two flags rather
// than a second script that would drift from this one's constants.
const finishing = process.argv.includes("--finish")

// Where Observable writes the built site.
const OUTPUT_ROOT = "public"

// absolutiseFavicons rewrites every generated favicon reference to a site-absolute URL.
//
// A shared report first loads 404.html, which redirects to the app root with the token in #r=. Once
// the report has loaded, rememberActiveReport() restores /r/<token> with history.replaceState(). That
// changes the document URL without reloading index.html. Chrome may resolve its deferred favicon only
// after that history update, turning "./_file/..." into "/r/_file/...". Making the favicon absolute on
// every page removes the timing dependency: neither redirects nor History API updates can retarget it.
function absolutiseFavicons() {
  const prefix = sitePrefix()
  let rewrites = 0

  for (const page of filesIn(OUTPUT_ROOT).filter((path) => path.endsWith(".html"))) {
    const html = readFileSync(page, "utf8")
    const rewritten = html.replace(
      /(<link\b(?=[^>]*\brel="icon")[^>]*\bhref=")\.\/([^"]*)"/g,
      (_match, attribute, path) => `${attribute}${prefix}${path}"`,
    )

    if (rewritten !== html) {
      writeFileSync(page, rewritten)
      rewrites += 1
    }

    if (/<link\b(?=[^>]*\brel="icon")[^>]*\bhref="\.\//.test(rewritten)) {
      throw new Error(`${page} still has a relative favicon reference after rewriting.`)
    }
  }

  console.log(`Rewrote relative favicon references in ${rewrites} generated HTML page${rewrites === 1 ? "" : "s"}\n`)
}

function sitePrefix() {
  const base = process.env[SITE_BASE_ENV] || "/"
  return base.endsWith("/") ? base : `${base}/`
}

// absolutiseRedirectPage rewrites 404.html's remaining relative asset references to site-absolute ones.
//
// This is the one page served at a depth it cannot know. A shared report lives at /r/<token>, and a
// static host answers it with 404.html *at that path* - so every "./x" on it resolves to "/r/x" and
// 404s: the favicon, the stylesheet, every module preload.
//
// Observable's <base href> is meant to correct that, and on paper it does. This page is the one place
// that cannot afford to depend on it: the base is emitted by the framework rather than by us, it has to
// match the deployment path exactly, and a shared link is the one URL a reader arrives at cold, where a
// broken page is the entire experience. Rewriting the references removes the dependency rather than
// tuning it, so the page resolves identically at any depth, under any base, on any host.
//
// Only this page. Every other one is served from the directory its assets sit in.
function absolutiseRedirectPage() {
  const page = join(OUTPUT_ROOT, "404.html")
  if (!existsSync(page)) {
    throw new Error(`Expected ${page} after the build. The redirect page is what serves every shared report link.`)
  }

  const prefix = sitePrefix()
  const html = readFileSync(page, "utf8")

  // Attributes, and the module specifiers in the page's own inline script. Framework writes
  //   import {define} from "./_observablehq/client.<hash>.js"
  // there, and a module specifier resolves against the document base exactly as an attribute does.
  const rewritten = html
    .replace(/((?:href|src)=")\.\/([^"]*)"/g, (_match, attribute, path) => `${attribute}${prefix}${path}"`)
    .replace(/(from\s*")\.\/([^"]*)"/g, (_match, keyword, path) => `${keyword}${prefix}${path}"`)
    .replace(/(import\(")\.\/([^"]*)"/g, (_match, keyword, path) => `${keyword}${prefix}${path}"`)

  const remaining = (rewritten.match(/"\.\//g) ?? []).length
  if (remaining > 0) {
    throw new Error(
      `${page} still holds ${remaining} relative reference(s) after rewriting. This page is served at ` +
        "/r/<token>, where anything relative resolves a directory too deep and 404s.",
    )
  }

  writeFileSync(page, rewritten)
  const rewrites = (html.match(/"\.\//g) ?? []).length

  // The favicon is not among these - absolutiseFavicons covers it on every page, because it is the one
  // asset a History API update can retarget after the document has loaded.
  console.log(`Rewrote ${rewrites} relative reference${rewrites === 1 ? "" : "s"} in ${page} to ${prefix}\n`)
}

if (finishing) {
  absolutiseFavicons()
  absolutiseRedirectPage()
  process.exit(0)
}

function filesIn(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...filesIn(path))
    else if (entry.isFile()) found.push(path)
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
    if (!existsSync(source)) continue

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

// stageContent puts the non-generated files where Observable expects them.
//
// Watch mode symlinks instead of copying, so editing src/index.md reaches the preview the moment it is
// saved. A one-shot build copies: the staged root is an input to a published artifact, and it should
// not be able to change underneath the build that is reading it.
function stageContent() {
  rmSync(STAGED_ROOT, { recursive: true, force: true })
  mkdirSync(STAGED_ROOT, { recursive: true })

  for (const name of CONTENT) {
    const source = resolve(SOURCE_ROOT, name)
    if (!existsSync(source)) continue

    if (watching) symlinkSync(source, join(STAGED_ROOT, name), statSync(source).isDirectory() ? "dir" : "file")
    else cpSync(source, join(STAGED_ROOT, name), { recursive: true })
  }

  verifyStagedAssets()

  const realCache = resolve(SOURCE_ROOT, CACHE_DIR)
  if (existsSync(realCache)) symlinkSync(realCache, join(STAGED_ROOT, CACHE_DIR), "dir")
}

// Minified for a published artifact, readable for the dev loop. Names and a sourcemap are what make a
// stack trace in the preview point back at a real line, and nothing ships from a watch run.
const bundleOptions = {
  entryPoints: [ENTRY],
  outfile: BUNDLE,
  bundle: true,
  format: "esm",
  // esnext, so this step only removes - it never downlevels syntax Observable already accepts.
  target: "esnext",
  minify: !watching,
  sourcemap: watching ? "inline" : false,
  legalComments: "none",
  logLevel: "warning",
}

mkdirSync(dirname(STAGED_ROOT), { recursive: true })
stageContent()

if (!watching) {
  await esbuild.build(bundleOptions)

  const sources = [ENTRY, ...filesIn(join(SOURCE_ROOT, "lib"))]
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts"))
  const before = sources.reduce((total, path) => total + statSync(path).size, 0)
  const after = statSync(BUNDLE).size
  const percent = before > 0 ? Math.round(((before - after) / before) * 100) : 0

  console.log(
    `Bundled ${sources.length} modules → app.js: ` +
      `${(before / 1024).toFixed(1)} kB → ${(after / 1024).toFixed(1)} kB (-${percent}%)\n`
  )
} else {
  const context = await esbuild.context(bundleOptions)
  await context.watch()
  console.log(`Watching ${SOURCE_ROOT} → ${BUNDLE}\n`)

  // Observable owns the terminal from here. It watches the staged root, so each rebuild esbuild
  // writes triggers its live reload the same way a hand-edited file would.
  const previewArgs = [
  "preview",
  "--host=0.0.0.0",
  ...process.argv.slice(2).filter((arg) => arg !== "--watch"),
]

const preview = spawn("observable", previewArgs, {
  stdio: "inherit",
  env: { ...process.env, [STRIPPED_BUILD_ENV]: "1" },
})

  const shutdown = async () => {
    await context.dispose()
    rmSync(STAGED_ROOT, { recursive: true, force: true })
  }

  preview.on("exit", async (code) => {
    await shutdown()
    process.exit(code ?? 0)
  })
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => preview.kill(signal))
}
