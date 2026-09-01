// See https://observablehq.com/framework/config for documentation.
import packageMetadata from "./package.json" with {type: "json"};
import {STAGED_ROOT, STRIPPED_BUILD_ENV} from "./scripts/build-root.mjs";

// `observable build` and `observable deploy` both write a published artifact, and both must read the
// stripped root staged by scripts/build.mjs rather than src directly - otherwise the site ships every
// source comment. package.json chains the two halves and sets this flag; invoking the CLI by hand
// skips the strip, so that path is refused loudly instead of quietly producing an unstripped build.
//
// `observable preview` is deliberately not covered: a local preview should serve the real, commented
// source, and it publishes nothing.
const emitsArtifact = ["build", "deploy"].includes(process.argv[2]);
const isStrippedBuild = process.env[STRIPPED_BUILD_ENV] === "1";

if (emitsArtifact && !isStrippedBuild) {
  throw new Error(
    `Refusing to ${process.argv[2]} directly from the observable CLI.\n` +
      "Run `pnpm run build` (or `pnpm run deploy`), which strips the sources first.\n" +
      "See the Build section of README.md."
  );
}

export default {
  // The app’s title; used in the sidebar and webpage titles.
  title: "Tapoo Oracle",

  // Named so the analytics app is never read as a standalone tool: the profile it reports is only
  // meaningful as a reading of Tapoo's own agent-api logs.
  header: '<span class="oracle-header-label">Tapoo analytics extension</span>',
  // Says only what a reader needs to trust the page: which build answered, where the logs come from,
  // and what does and does not leave their browser.
  //
  // "never uploaded" was true of the log and false of its address. A shared report is a /r/<token>
  // route, so the token - which decodes back to the log URL - travels in the request path and lands
  // in the host's access logs on every visit. The contents are still only ever read in the browser;
  // the claim is narrowed to that, because a blanket "never uploaded" beside a feature that does
  // send something is the kind of sentence this project exists to avoid.
  footer:
    `<strong>Tapoo Oracle v${packageMetadata.version}</strong> · ` +
    'Reads gameplay logs from <a href="https://github.com/dmigwi/tapoo">dmigwi/tapoo</a>. ' +
    'Log contents are analyzed in your browser and never uploaded; a shared link carries the ' +
    'log address to the host serving this page.',

  // The pages and sections in the sidebar. If you don’t specify this option,
  // all pages will be listed in alphabetical order. Listing pages explicitly
  // lets you organize them into sections and have unlisted pages.
  pages: [
    // {name: "Analyzer", path: "/"}
  ],

  // Tapoo's maze redrawn in this site's palette. Same artwork so the two tabs read as one family;
  // different colour so they are told apart at 16px, where the shapes alone are indistinguishable.
  // src/images/favicon.svg records which Tapoo colour each role maps from.
  head:
    '<link rel="icon" type="image/svg+xml" href="./images/favicon.svg">' +
    // Inline, in the head, and deliberately not a module: a shared report lives at /r/<token>, which
    // a static host answers with 404.html served *at that path*. Every asset reference in that page
    // is relative, so they resolve one directory too deep and 404 - meaning nothing that depends on
    // the framework's own JS can be trusted to run there. This has no dependencies and runs before
    // any of it.
    //
    // Harmless on every other page: the guard only matches a report route, so the app itself never
    // sees it fire.
    "<script>(function () {" +
    "var route = /\\/r\\/([A-Za-z0-9_-]+)\\/?$/;" +
    "var match = route.exec(location.pathname);" +
    "if (!match) return;" +
    // replace, not assign, so Back leaves the site rather than bouncing through the route again.
    "location.replace(location.origin + location.pathname.replace(route, '/') + '#payload=' + match[1]);" +
    "})();</script>",
  globalStylesheets: [],

  // The path to the source root.
  // A stripped build reads the staged copy; preview reads the real source root.
  root: isStrippedBuild ? STAGED_ROOT : "src",

  // Some additional configuration options and their defaults:
  style: "oracle.css",
  // sidebar: true, // whether to show the sidebar
  // toc: true, // whether to show the table of contents
  // pager: true, // whether to show previous & next links in the footer
  output: "public", // path to the output root for build
  // search: true, // activate search
  // linkify: true, // convert URLs in Markdown to links
  // typographer: false, // smart quotes and other typographic improvements
  // preserveExtension: false, // drop .html from URLs
  // preserveIndex: false, // drop /index from URLs
};
