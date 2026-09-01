// What the page imports.
//
// It sits beside index.md rather than inside lib/ because it belongs to the page, not to the app's
// module graph: it is the one file whose reason for existing is that a markdown fence needs something
// to import. Everything below it in lib/ is a module the app uses; this is the seam between the two.
//
// One entry, so the build has a single graph to bundle and src/index.md has a single specifier. It
// re-exports rather than implements: the page's dependency on the app is stated here and nowhere else.

export { createReportTabsInput } from "./lib/report-tabs-control";
export { renderReportSections } from "./lib/report-view";
