// See https://observablehq.com/framework/config for documentation.
import packageMetadata from "./package.json" with {type: "json"};

export default {
  // The app’s title; used in the sidebar and webpage titles.
  title: "Tapoo Oracle",

  // Named so the analytics app is never read as a standalone tool: the profile it reports is only
  // meaningful as a reading of Tapoo's own agent-api logs.
  header: '<span class="oracle-header-label">Tapoo analytics extension</span>',
  // Says only what a reader needs to trust the page: which build answered, where the logs come
  // from, and that nothing leaves the browser. The rubric and its engine live in this repository, so
  // there is no upstream contract to credit here.
  footer:
    `<strong>Tapoo Oracle v${packageMetadata.version}</strong> · ` +
    'Reads gameplay logs from <a href="https://github.com/dmigwi/tapoo">dmigwi/tapoo</a>. ' +
    'Analyzed in your browser, never uploaded.',

  // The pages and sections in the sidebar. If you don’t specify this option,
  // all pages will be listed in alphabetical order. Listing pages explicitly
  // lets you organize them into sections and have unlisted pages.
  pages: [
    // {name: "Analyzer", path: "/"}
  ],

  // Tapoo's maze redrawn in this site's palette. Same artwork so the two tabs read as one family;
  // different colour so they are told apart at 16px, where the shapes alone are indistinguishable.
  // src/images/favicon.svg records which Tapoo colour each role maps from.
  head: '<link rel="icon" type="image/svg+xml" href="./images/favicon.svg">',
  globalStylesheets: [],

  // The path to the source root.
  root: "src",

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
