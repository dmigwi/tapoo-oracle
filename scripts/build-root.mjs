// Single definition of where the staged build root lives.
//
// Imported by scripts/build.mjs, which creates it, and by observablehq.config.js, which builds and
// previews from it. Keeping the path in one place is what stops the two halves of the build from
// disagreeing about where the staged sources are.
//
// It sits at the repository root rather than under .tmp so the thing Observable actually reads is
// visible while you work - during a `pnpm run dev` this directory *is* the served site, and being
// able to open it is worth more than keeping the tree tidy. It is generated, gitignored, and removed
// and rebuilt from scratch on every run: nothing here is a source file, and anything left in it by
// hand is deleted on the next build.
//
// Named for what it is rather than what it holds, and matching STAGED_ROOT so the directory on disk
// and the identifier in the code are the same word.
export const STAGED_ROOT = "staged"

// STRIPPED_BUILD_ENV is set by the build, deploy and dev scripts in package.json. It is the signal
// that scripts/build.mjs has already run and staged the bundle - see the guard in
// observablehq.config.js for why an unset value is refused rather than defaulted.
export const STRIPPED_BUILD_ENV = "ORACLE_STRIPPED_BUILD"

// SITE_BASE_ENV names the path the site is served from, when that is not the domain root.
//
// A GitHub Pages project site lives under /<repo>/, and Observable writes a <base href> into every page
// from its own `base` option - which defaults to "/". At the root that is right; under a project path
// every relative asset reference on a page resolves to the wrong place.
//
// It bites hardest on a shared report. /r/<token> is answered by 404.html served at that path, and with
// base "/" its six asset references all resolve to the domain root and 404 - verified against a
// faithful project-site simulation. The redirect still completes, because it is inline script that runs
// before any of them matter, so the link works while logging six failures every time someone opens one.
//
// Set it at build time: ORACLE_SITE_BASE=/tapoo-oracle/ pnpm run build
export const SITE_BASE_ENV = "ORACLE_SITE_BASE"
