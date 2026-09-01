// Single definition of where the stripped build root lives.
//
// Imported by scripts/build.mjs, which creates it, and by observablehq.config.js, which builds from
// it. Keeping the path in one place is what stops the two halves of the build from disagreeing about
// where the staged sources are.

export const STAGED_ROOT = ".tmp/build-root"

// STRIPPED_BUILD_ENV is set by the build and deploy scripts in package.json. It is the signal that
// scripts/build.mjs has already run and staged a stripped copy - see the guard in
// observablehq.config.js for why an unset value is refused rather than defaulted.
export const STRIPPED_BUILD_ENV = "ORACLE_STRIPPED_BUILD"
