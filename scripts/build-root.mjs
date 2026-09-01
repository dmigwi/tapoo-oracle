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
export const STAGED_ROOT = "components"

// STRIPPED_BUILD_ENV is set by the build, deploy and dev scripts in package.json. It is the signal
// that scripts/build.mjs has already run and staged the bundle - see the guard in
// observablehq.config.js for why an unset value is refused rather than defaulted.
export const STRIPPED_BUILD_ENV = "ORACLE_STRIPPED_BUILD"
