import type {Level, Region, Report} from "./types";

// Helpers shared by the suites.
//
// Not shipped: nothing in src/lib/app.ts reaches this, so it never enters the bundle.

/** Narrows a discriminated result to its success arm, failing the test if it is not one.
 *
 * The unions exist so production code cannot read a success field off a failure. A test asserting on
 * a known-good fixture is stating that it *is* a success, and this says so once - which is more
 * honest than a cast, because a fixture that stops decoding fails here with the reason attached
 * rather than at some later property access. */
export function expectOk<T extends {ok: boolean}>(result: T): Extract<T, {ok: true}> {
  if (!result.ok) {
    throw new Error(`expected a success, got: ${JSON.stringify(result)}`);
  }
  return result as Extract<T, {ok: true}>;
}

/** The failure arm, for the many tests that assert on a reason. */
export function expectErr<T extends {ok: boolean}>(result: T): Extract<T, {ok: false}> {
  if (result.ok) {
    throw new Error(`expected a failure, got: ${JSON.stringify(result)}`);
  }
  return result as Extract<T, {ok: false}>;
}

/** Asserts a value is present and returns it narrowed.
 *
 * Most uses are `querySelector`, which is `T | null` because a selector can miss. In a test the miss
 * *is* the failure, and saying so here names the selector in the message instead of letting a later
 * `.textContent` throw on null with no clue which node was absent. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}

/** `root.querySelector`, failing the test when the selector matches nothing. */
export function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  return must(root.querySelector<T>(selector), selector);
}

/** `root.querySelectorAll` as an array. Empty is a legitimate result, so this does not assert. */
export function queryAll<T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

/** The element at `index`, failing the test when the collection is shorter than that.
 *
 * `noUncheckedIndexedAccess` makes every index access `T | undefined`, which is right: in production
 * a short list is a case to handle. In a test, indexing past the end means the thing under test
 * produced the wrong number of items, and that is worth saying directly rather than as a cascade of
 * `possibly undefined` at each later property. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}, got ${items.length} in total`);
  }
  return item;
}

/** A rendered region as an element, failing the test when the section rendered nothing.
 *
 * `Region` is `Element | ""` because a section that has nothing to say renders nothing, and the page
 * interpolates the empty string rather than an empty node. A test reaching into a region has already
 * asserted it rendered; this states that once instead of at every property. */
export function rendered(region: Region): HTMLElement {
  if (region === "") {
    throw new Error("expected a rendered region, got the empty one");
  }
  return region as HTMLElement;
}

/** A report carrying nothing but the rounds a maze test is about.
 *
 * The replay views take a whole `Report` because that is what the page hands them, but the maze
 * suites are about rounds. Stating the rest once here keeps each case to the round it exercises, and
 * keeps the two suites agreeing on what an otherwise-empty report looks like. */
export function reportWith(...levels: Level[]): Report {
  return {
    label: "fixture",
    model: null,
    player: null,
    predictions: 0,
    rounds: levels.length,
    traversalSpeed: null,
    traversalSpeedClass: null,
    capabilities: [],
    violations: [],
    diagnostics: {endpointFailures: 0, emptyResponses: 0, unparseableResponses: 0, tokenExhaustions: 0},
    levels,
  };
}
