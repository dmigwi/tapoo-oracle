import { defineConfig } from "vitest/config"

const coverageDirectory = process.env.VITEST_COVERAGE_DIR ?? ".tmp/coverage"

export default defineConfig({
  test: {
    // Node by default: turning a log into rubric answers is pure, and most of this suite never
    // touches a DOM. The files that do opt in per file with an @vitest-environment docblock, so the
    // cost of jsdom is paid only where the code under test genuinely needs a document.
    environment: "node",
    include: ["src/**/*.test.js", "scripts/**/*.test.mjs"],
    coverage: {
      // The analysis is owned here now rather than vendored from Tapoo, so it is measured here too:
      // leaving it out would report this app's coverage while the code that produces every verdict
      // went uncounted.
      include: ["src/components/**/*.js", "src/analysis/**/*.js"],
      provider: "v8",
      reporter: ["text", "cobertura"],
      reportsDirectory: coverageDirectory,
    },
  },
})
