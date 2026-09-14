// Helpers with no home of their own.
//
// This module imports nothing - not a sibling, not even a type - and that is the whole design. A module
// that imports nothing can be imported by anything, so a helper living here is reachable from every
// other module in the graph without the question of direction ever arising.
//
// The rule is not decoration. `log-contract.ts` needed the record coercion that `rubric-context.ts`
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
 * showed another, leaving a test unable to assert on what a reader actually sees. And deliberately not
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
  const hash = createFnv1a64();
  hash.update(text);
  return hash.digest();
}

/** createFnv1a64 is the same hash taken a piece at a time, for input too large to hold as one string.
 *
 * Updates as if the pieces were concatenated, with one caveat: a boundary must not fall inside a surrogate
 * pair, because each piece is UTF-8 encoded on its own and a split half encodes as U+FFFD. Pieces of
 * complete JSON never split one - JSON.stringify escapes lone surrogates to ASCII.
 *
 * The 64-bit state is four 16-bit limbs (v0 lowest) rather than a BigInt, and this is the producer's own
 * arithmetic: a BigInt per byte made the snapshot's megabyte of entries cost 17ms where this costs 5ms,
 * and the ratio holds up the size ceiling - 1.8s against 0.4s at 100 MB. The prime is 2^40 + 435, so a
 * multiply is each limb times 435 plus v0
 * and v1 shifted two limbs and 8 bits up; every intermediate stays below 2^31, so no step leaves
 * small-integer arithmetic. encodeInto writes UTF-8 into one reused buffer, so no copy of the input is
 * made.
 *
 * Implementation reference: https://www.ietf.org/archive/id/draft-eastlake-fnv-22.html */
export function createFnv1a64(): {update(text: string): void; digest(): string} {
  // The FNV-1a 64-bit offset basis 0xcbf29ce484222325, split into limbs.
  let v0 = 0x2325;
  let v1 = 0x8422;
  let v2 = 0x9ce4;
  let v3 = 0xcbf2;
  const encoder = new TextEncoder();
  let buffer = new Uint8Array(1 << 16);

  return {
    update(text: string): void {
      // Three bytes per UTF-16 unit is UTF-8's worst case, so encodeInto can never truncate.
      if (buffer.length < text.length * 3) {
        buffer = new Uint8Array(text.length * 3);
      }
      const {written} = encoder.encodeInto(text, buffer);
      for (let i = 0; i < written; i++) {
        v0 ^= buffer[i] as number;
        const t0 = v0 * 435;
        const t1 = v1 * 435 + (t0 >>> 16);
        const t2 = v2 * 435 + (v0 << 8) + (t1 >>> 16);
        v3 = (v3 * 435 + (v1 << 8) + (t2 >>> 16)) & 0xffff;
        v2 = t2 & 0xffff;
        v1 = t1 & 0xffff;
        v0 = t0 & 0xffff;
      }
    },
    digest(): string {
      return `0x${[v3, v2, v1, v0].map((limb) => limb.toString(16).padStart(4, "0")).join("")}`;
    },
  };
}

/** checksumEntries is fnv1a64Checksum(JSON.stringify(entries)) without ever building that string.
 *
 * An array's JSON is "[", its elements' JSON joined by ",", then "]" - so hashing those pieces in order
 * gives the identical digest while holding one entry's text at a time rather than a second copy of a log
 * that may reach the size ceiling. The producer computes the checksum this same way, which is what makes
 * the two comparable at all.
 *
 * Memory is the whole of the argument: at 20 MB of entries this measures 87ms against 69ms for hashing one
 * joined string, so it buys nothing in time and costs a little. What it does not do is allocate 20 MB of
 * string to read once and drop, beside a log the parse is already holding.
 *
 * Synchronous, unlike the producer's, which yields to the page between slices: this runs inside a parse
 * that already holds the whole file, and there is no frame to protect - the app is not drawing yet. */
export function checksumEntries(entries: readonly unknown[]): string {
  const hash = createFnv1a64();

  hash.update("[");
  for (let index = 0; index < entries.length; index++) {
    if (index > 0) {
      hash.update(",");
    }
    // What JSON.stringify writes for an element it has no text for - undefined, a function, a symbol - is
    // "null", and this has to write the same or the two answers part company on an array it would not.
    hash.update(JSON.stringify(entries[index]) ?? "null");
  }
  hash.update("]");
  return hash.digest();
}
