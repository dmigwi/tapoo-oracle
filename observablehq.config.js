// See https://observablehq.com/framework/config for documentation.
import packageMetadata from "./package.json" with {type: "json"};
import {SITE_BASE_ENV, STAGED_ROOT, STRIPPED_BUILD_ENV} from "./scripts/build-root.mjs";

// Every Observable command reads the staged root, never src directly.
//
// src/lib holds TypeScript whose import specifiers are extensionless, and Observable's resolver
// rejects those outright - so the module graph under src is not something it can serve. Only the
// bundle scripts/build.mjs writes is. package.json chains the two halves and sets this flag;
// invoking the CLI by hand skips the bundle, so that path is refused loudly rather than failing
// later with `empty extension` or, worse, quietly shipping unbundled sources.
//
// preview is covered along with build and deploy: serving something the build never produces is the
// failure this arrangement exists to prevent.
const needsStagedRoot = ["build", "deploy", "preview"].includes(process.argv[2]);
const isStagedBuild = process.env[STRIPPED_BUILD_ENV] === "1";

if (needsStagedRoot && !isStagedBuild) {
  const script = process.argv[2] === "preview" ? "dev" : process.argv[2];
  throw new Error(
    `Refusing to ${process.argv[2]} directly from the observable CLI.\n` +
      `Run \`pnpm run ${script}\`, which bundles the sources first.\n` +
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
    // A shared report lives at /r/<token>, which a static host answers with 404.html served *at that
    // path*. This turns that into a hop to the app root, carrying the token in the fragment. It has no
    // dependencies and runs at parse time, so it does not wait on the framework's own JS - which is the
    // point, because on that page the framework may not have loaded at all.
    //
    // It used to also document.write('<base href="../">') to correct the page's asset paths. That never
    // worked: Observable emits its own <base> from the `base` option above, before any of this, and a
    // document honours only its first <base href> - so the second was parsed and ignored. The asset
    // links are emitted ahead of this script too, so even a winning base would have arrived late.
    //
    // `base` is what actually fixes them, and it fixes them for every page at every depth rather than
    // for this one route.
    //
    // Harmless on every other page: the guard only matches a report route, so the app itself never
    // sees it fire.
    "<script>(function () {" +
    "var route = /\\/r\\/([A-Za-z0-9_-]+)\\/?$/;" +
    "var match = route.exec(location.pathname);" +
    "if (!match) return;" +
    // replace, not assign, so Back leaves the site rather than bouncing through the route again.
    // The fragment carries the same "r=" marker the /r/ path segment does. A bare #<token> is the same
    // shape as an ordinary page anchor, so the app could not tell one from the other; the marker is
    // what makes the hop unambiguous, exactly as /r/ does for the public form.
    "location.replace(location.origin + location.pathname.replace(route, '/') + '#r=' + match[1]);" +
    "})();</script>" +
    '<link rel="icon" type="image/svg+xml" href="./images/favicon.svg">',
  globalStylesheets: [],

  // The path to the source root.
  // A stripped build reads the staged copy; preview reads the real source root.
  root: STAGED_ROOT,

  // Where the site is served from. "/" for a domain root, "/<repo>/" for a GitHub Pages project site.
  //
  // Observable writes this into every page as <base href>, so it is what every relative asset reference
  // resolves against. Getting it wrong is invisible on the app's own page - the browser is already in
  // the right directory - and breaks a shared report, whose 404.html is served one segment deeper.
  //
  // Read from the environment rather than hardcoded: the repository does not know where it will be
  // deployed, and baking one path in would silently break every other target.
  base: process.env[SITE_BASE_ENV] || "/",

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
