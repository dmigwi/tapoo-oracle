// What the page imports.
//
// It sits beside index.md rather than inside lib/ because it belongs to the page, not to the app's
// module graph: it is the one file whose reason for existing is that a markdown fence needs something
// to import. Everything below it in lib/ is a module the app uses; this is the seam between the two.
//
// One entry, so the build has a single graph to bundle and src/index.md has a single specifier. It
// re-exports rather than implements: the page's dependency on the app is stated here and nowhere else.
//
// The three calls index.md makes, and where each one goes. All three enter through report-view, which
// re-exports the tabs view rather than the page reaching two modules. Every module on this path opens
// with an "Entry point: what <caller> calls" section holding the function that caller reaches, and its
// helpers after, so the path reads downwards from whichever file it lands in.
//
//   createLogTabsInput      report-view -> log-tabs-view    the viewof element owning the tab state
//     |- log-tabs-state     loadNewLogTabFromUrl -> loadLogTabFields -> share-link
//     |                     .loadTapooLogFromUrl -> log-contract.parseTapooLogText, then
//     |                     rounds.sliceLogIntoRounds cuts the log into one RoundSlice per round.
//     |                     Nothing is answered yet.
//     `- share-link         the shared-report link a reader may have arrived on
//
//   renderReportSections    report-view       one call per render, returning the page's five regions
//     |- rubric-report      roundReportFor answers the round on screen, once, and memoizes it:
//     |                     buildReport (rubric-engine.buildContext, rounds.buildLevels,
//     |                     answerRubric), plus log-contract.parseGameRound for its payloads
//     |- report-adapters    that report as rows, cards and sentences
//     `- maze-view          createMazeReplay draws the round, via maze-model.mazeReplayModel
//
//   stampBuildAge           report-view       fills in the footer's "(3 days ago)"

export { createLogTabsInput, renderReportSections, stampBuildAge } from "./lib/report-view";
