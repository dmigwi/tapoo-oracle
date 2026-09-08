// Helpers with no home of their own.
//
// This module imports nothing - not a sibling, not even a type - and that is the whole design. A module
// that imports nothing can be imported by anything, so a helper living here is reachable from every
// other module in the graph without the question of direction ever arising.
//
// The rule is not decoration. `log-contract.ts` needed the record coercion that `rubric-engine.ts`
// already exported, could not have it - the rubric engine imports the log contract - and so wrote its
// own, twice over, in shapes that disagreed about whether an array is a record. That is what a helper
// with nowhere to live costs.
//
// What belongs here: pure, document-free, and either genuinely generic or already wanted by two
// modules. A helper only one module uses stays with that module; this is not a drawer for anything
// small. Nothing enforces the import rule - not the linter, not a test - so it holds only as long as
// each new helper is added with it in mind; the first import here is what makes this module ordinary.

// --- Reading values that arrived from outside the app ---
//
// Everything in this section sits at a trust boundary: parsed JSON, a URL, a DOM input. The parameter
// type is `unknown` because that is the honest description of what turns up, and each reader's job is
// to turn it into something the rest of the app can be checked against.

/** Reads untrusted input as trimmed text, or "" when the value is not text at all.
 *
 * Coercing rather than narrowing is deliberate: the caller's next act is to validate, and validating
 * one string is simpler than branching on every type that could arrive. A number or a boolean has an
 * unambiguous text form, so it gets one.
 *
 * A composite does not. `String({})` is "[object Object]" - fifteen characters that pass every
 * emptiness check downstream, so an object would reach a URL validator as an address to reject for
 * the wrong reason, or a tab label as the visible name of a report. An object is not text, so it
 * reads as absent.
 */
export function asTrimmedText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

/** Narrows arbitrary JSON to a record, for a caller that wants to branch rather than coerce.
 *
 * An array is not a record here. `typeof [] === "object"` is true, so the looser test that omits the
 * array check reports a list as a record and hands the caller something whose named fields are all
 * undefined - a shape that reads as "present but empty" when the truth is "wrong kind of thing".
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** asRecord is the boundary between arbitrary JSON and everything downstream of it.
 *
 * A log's `details` and a tool result's parsed content are whatever the producer wrote. Narrowing them
 * to a record of unknowns - rather than trusting a shape - is what forces each read to say what it
 * expects, and is why a malformed field produces a skipped entry instead of a TypeError that takes the
 * whole report down with it.
 */
export const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** asArray keeps a field that should be a list from being iterated when it is not one. */
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// --- Text ---

/** Capitalises the first character and leaves the rest of the string exactly as it was.
 *
 * Deliberately not a CSS `text-transform`: that would leave the DOM holding one string while the screen
 * showed another, so a test could no longer assert on what a reader actually sees. And deliberately not
 * a title-caser - the callers are single words whose remainder is already correct, and a helper that
 * rewrote the tail would quietly mangle any value that had a capital of its own.
 */
export const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

// --- Numbers ---

/** clamp bounds a value into an inclusive range.
 *
 * Both callers are bounding an index into a list, and both wrote the nested Math calls out by hand with
 * the arguments in a different order - which is the kind of thing that reads as correct right up until
 * one of them has its min and max the wrong way round.
 */
export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** Renders a count the way a reader expects to see one, with thousands separators. */
export function formatCount(value: number | string): string {
  return Number(value).toLocaleString("en-US");
}

/** How long ago `from` was, relative to `now`, in the largest unit that still reads as a whole number.
 *
 * Intl.RelativeTimeFormat rather than a hand-rolled ladder: it owns the pluralisation, and the units it
 * picks are the ones a reader expects. `numeric: "always"`, so a fresh build reads "2 seconds ago"
 * rather than "now" - this is a report about exact figures, and "now" is the one answer that stops being
 * true the moment it is read.
 */
export function relativeAge(from: Date, now: Date): string {
  const seconds = Math.round((from.getTime() - now.getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat("en-US", {numeric: "always"});

  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
  ];

  let value = seconds;
  for (const [unit, limit] of steps) {
    if (Math.abs(value) < limit) return format.format(value, unit);
    value = Math.trunc(value / limit);
  }

  return format.format(value, "year");
}

// --- Hashing ---

/** fnv1a64Checksum is the FNV-1a 64-bit hash Tapoo stamps onto an encoded maze, over UTF-8 bytes.
 *
 * Ported rather than imported - the alternative is trusting a structure string that may have been
 * truncated in transit and then rendering a maze that never existed.
 */
export function fnv1a64Checksum(text: string): string {
  const offsetBasis = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  let hash = offsetBasis;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }

  return `0x${hash.toString(16).padStart(16, "0")}`;
}
