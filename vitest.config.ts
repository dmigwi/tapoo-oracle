import { defineConfig } from "vitest/config"

const coverageDirectory = process.env.VITEST_COVERAGE_DIR ?? ".tmp/coverage"

export default defineConfig({
  test: {
    // Node by default: turning a log into rubric answers is pure, and most of this suite never
    // touches a DOM. The files that do opt in per file with an @vitest-environment docblock, so the
    // cost of jsdom is paid only where the code under test genuinely needs a document.
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      // The analysis is owned here now rather than vendored from Tapoo, so it is measured here too:
      // leaving it out would report this app's coverage while the code that produces every verdict
      // went uncounted.
      include: ["src/**/*.ts"],
      // types.ts and test-support.ts carry no runtime behaviour of the app: declarations and
      // helpers the suites use. Counting them would report coverage of the tests themselves.
      exclude: ["src/**/*.test.ts", "src/lib/types.ts", "src/lib/test-support.ts", "src/app.ts"],
      provider: "v8",
      reporter: ["text", "cobertura"],
      reportsDirectory: coverageDirectory,
    },
  },
})
