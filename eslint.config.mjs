// @ts-check

import js from "@eslint/js"
import globals from "globals"
import { defineConfig } from "eslint/config"

export default defineConfig(
  {
    // src/vendor is copied verbatim from Tapoo and is linted there, against that repository's rules.
    // Linting it here would produce findings that cannot be fixed without editing a vendored file,
    // which is the one thing the drift check forbids.
    ignores: ["node_modules/**", "dist/**", "src/.observablehq/**", "src/vendor/**"],
  },
  {
    // The Observable page components run in the browser; the vendoring tools run in Node.
    files: ["src/components/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["scripts/**/*.mjs", "**/*.test.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
)
