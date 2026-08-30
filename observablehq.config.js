// See https://observablehq.com/framework/config for documentation.
export default {
  // The app’s title; used in the sidebar and webpage titles.
  title: "Tapoo Oracle",

  // Named so the analytics app is never read as a standalone tool: the profile it reports is only
  // meaningful as a reading of Tapoo's own agent-api logs.
  header: '<span style="font:600 0.8rem ui-monospace,monospace;letter-spacing:0.04em;text-transform:uppercase">Tapoo analytics extension</span>',
  footer:
    'Analysis contract vendored from <a href="https://github.com/dmigwi/tapoo">dmigwi/tapoo</a>. ' +
    'Logs are analyzed in your browser and never uploaded.',

  // The pages and sections in the sidebar. If you don’t specify this option,
  // all pages will be listed in alphabetical order. Listing pages explicitly
  // lets you organize them into sections and have unlisted pages.
  pages: [
    {name: "Analyzer", path: "/"}
  ],

  // Content to add to the head of the page, e.g. for a favicon:
  head: "",

  // The path to the source root.
  root: "src",

  // Some additional configuration options and their defaults:
  // theme: "default", // try "light", "dark", "slate", etc.
  // sidebar: true, // whether to show the sidebar
  // toc: true, // whether to show the table of contents
  // pager: true, // whether to show previous & next links in the footer
  // output: "dist", // path to the output root for build
  // search: true, // activate search
  // linkify: true, // convert URLs in Markdown to links
  // typographer: false, // smart quotes and other typographic improvements
  // preserveExtension: false, // drop .html from URLs
  // preserveIndex: false, // drop /index from URLs
};
