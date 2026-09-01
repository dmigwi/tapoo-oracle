// Reading values that arrived from outside the app.
//
// Everything here sits at a trust boundary: parsed JSON, a URL, a DOM input. The type is `unknown`
// because that is the honest description of what turns up, and each reader's job is to turn it into
// something the rest of the app can be checked against.

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
export function asTrimmedText /* probe */(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}
