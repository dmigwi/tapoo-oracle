import { defineConfig } from "vitest/config"

const coverageDirectory = process.env.VITEST_COVERAGE_DIR ?? ".tmp/coverage"

export default defineConfig({
  test: {
    // The adapter and the vendoring tools are pure - no DOM is involved in turning a log into rubric
    // answers, so the suite runs in plain Node rather than paying for jsdom.
    environment: "node",
    include: ["src/**/*.test.js", "scripts/**/*.test.mjs"],
    coverage: {
      // src/vendor is upstream code covered by upstream's own suite. Measuring it here would report
      // this app's coverage as whatever share of Tapoo's engine one fixture happens to exercise.
      include: ["src/components/**/*.js"],
      provider: "v8",
      reporter: ["text", "cobertura"],
      reportsDirectory: coverageDirectory,
    },
  },
})
