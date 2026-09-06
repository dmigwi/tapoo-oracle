// The footer's "last modified" line, finished in the browser.
//
// The date itself is stamped at build time by observablehq.config.js, because that is the only moment
// that knows it. How long ago that was can only be answered when someone is looking, so the config
// writes a <time> element carrying the machine-readable instant and this fills in the human part.
//
// Split that way on purpose: a build-time string saying "0 seconds ago" would be a lie on every visit
// after the first, and a fully client-rendered date would leave the footer blank for a reader with
// scripting off. What ships in the HTML is already true and already useful; this only sharpens it.

import { relativeAge } from "./utils";

/** The element the config writes, found by attribute rather than by position in the footer. */
const STAMP = "time[data-build-age]";

/** Appends "(3 days ago)" to the build stamp, if the page has one.
 *
 * `now` is a parameter rather than read inside, so the age can be tested at a fixed instant instead of
 * whenever the suite happens to run.
 *
 * Silent when the stamp is missing or its datetime does not parse: this is a footer decoration, and a
 * page that renders everything else correctly must not fail over it.
 */
export function stampBuildAge(root: ParentNode, now: Date): void {
  const stamp = root.querySelector(STAMP);
  const iso = stamp?.getAttribute("datetime");
  if (!stamp || !iso) return;

  const built = new Date(iso);
  if (Number.isNaN(built.getTime())) return;

  // Replaced rather than appended, so a second call - a re-render, a hot reload - does not stack a
  // second parenthetical onto the first.
  const age = stamp.parentElement?.querySelector(".build-age") ?? null;
  const node = age ?? document.createElement("span");
  node.className = "build-age";
  node.textContent = ` (${relativeAge(built, now)})`;
  if (!age) stamp.after(node);
}
