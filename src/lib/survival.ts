// What a run spent, against what the maze costs.
//
// A round begins with one decay unit per cell of the maze and spends at least one per turn, so the whole
// of a run's story can be told in that one unit: what it paid for its errors, what it earned back by
// batching moves, and whether what remained could still reach the destination. This module is the
// arithmetic of that account, and the rule for when a run could no longer finish.
//
// Its own module rather than geometry.ts, which holds the derivations a maze admits on its own: these
// read a round - its turns, and the grades Tapoo put on the cells those turns entered. And not
// rubric-contract.ts either, which answers whether a round can be compared at all. This answers what the
// round did, in the unit the round was scored in.
//
// Nothing here is live. Every figure needs the decoded maze, which exists only in the log, so a verdict
// is a reader's afterwards and never something the model could have consulted mid-run. The wording keeps
// to that: a run "could not finish from turn N", never "should have stopped".

import type {AgentSummary} from "./types";

// --- The decay ledger ---

/** The three terms a run's decay account splits into, and the two depths that judge it.
 *
 * Reported as terms, never as the headroom alone. Headroom is a function of the batch depth achieved, so
 * a bare figure invites being read as a property of the run; the three terms name three different causes,
 * and which one moved is the whole question. */
export type DecayLedger = {
  /** `p` - decay units charged beyond one per turn: what the run's errors cost it. */
  errorDebt: number;
  /** `b` - applied moves per turn: how deep the run's batches actually ran. */
  batchDepth: number;
  /** `A - moves` - units the maze's size leaves over the moves that were spent. Negative on a branching
   * maze, where a dead end costs two moves per cell. */
  routeSlack: number;
  /** `moves - turns` - what batching earned back: every move past the first in a turn is a cell entered
   * for no extra charge. */
  batchCredit: number;
  /** `A - moves/b - p`, which at the depth achieved is the three terms above summed. */
  headroom: number;
  /** `b_min` - the batch depth the run would have needed to cover the maze on the budget its errors
   * left it. Under 1 means it could have crawled; over 1 means it had to batch or lose. */
  neededDepth: number;
};

/** decayLedger splits what a round spent into the three terms that caused it.
 *
 * `cells` is the maze's cell count, which is also the round's opening budget; `decayCharged` is what the
 * round was charged over its turns; `played` is every turn taken and every move that landed. Both are the
 * round's, added across its seats, because the budget is the maze's and every seat draws on the one of it.
 *
 * Null rather than zeros wherever the account cannot be drawn: a round with no turns, no moves or no
 * charge has no ledger, and a zero would read as a measurement. Null too where the charge is below one
 * per turn, which is a log disagreeing with itself rather than a run that found a discount -
 * roundTotalsCheck is where that is reported. */
export function decayLedger({
  cells,
  decayCharged,
  played,
}: {
  cells: number;
  decayCharged: number | null;
  played: AgentSummary["played"];
}): DecayLedger | null {
  if (played === null || decayCharged === null || played.turnsTaken === 0 || played.movesApplied === 0) {
    return null;
  }

  const errorDebt = decayCharged - played.turnsTaken;
  // A budget the errors already exhausted leaves no depth that could have covered the maze, and the
  // division below would answer with a sign rather than a depth.
  if (errorDebt < 0 || cells - errorDebt <= 0) {
    return null;
  }

  const routeSlack = cells - played.movesApplied;
  const batchCredit = played.movesApplied - played.turnsTaken;
  return {
    errorDebt,
    batchDepth: played.movesApplied / played.turnsTaken,
    routeSlack,
    batchCredit,
    // The sum, not the formula: at the depth achieved, moves/b is exactly the turns taken, so
    // A - moves/b - p and slack + credit - p are the same integer - and summing the reported terms keeps
    // it one, where the division would leave a figure that prints as 2.9999999999999996.
    headroom: routeSlack + batchCredit - errorDebt,
    neededDepth: played.movesApplied / (cells - errorDebt),
  };
}

// --- When a run could no longer finish ---

/** The most cells a turn has ever been seen to enter for the first time.
 *
 * Measured, not assumed: across the twelve captures to hand on 2026-09-28, 2,377 turns with a resolvable
 * replay start entered 0, 1, 2, 3 or 4 new cells - 615, 1,548, 189, 22 and 3 turns of each - and none
 * entered a fifth. Tapoo's own prompt asks for two to four moves a turn, which is where the ceiling comes
 * from; a turn may apply more than four moves and one applied nineteen, but the extra ones were retracing
 * ground already covered.
 *
 * This is what makes the verdict monotone, so a capture showing five raises it here and nowhere else. A
 * cap set too high only makes the verdict slower to fire, never wrong. */
export const NEW_CELLS_PER_TURN_CAP = 4;

/** The fastest sustained pace of new route cells per decay unit any run has held.
 *
 * A warning threshold and never a verdict: it is the best a run has been observed to do, not a bound
 * anything proves, and a run beating it would be a record rather than an error. Same measurement date. */
export const FASTEST_SUSTAINED_PACE = 1.52;

/** What one turn's position says about whether the destination is still reachable.
 *
 * `lost` is the only one of these that is a verdict. The other three are paces: they say a run is behind
 * where it would need to be, which is a warning about a run that may still recover. */
export type SurvivalFlags = {
  lost: boolean;
  behindObservedPace: boolean;
  beyondDecayLeft: boolean;
  beyondOwnPace: boolean;
};

/** survivalFlags reads one turn's position against the budget it has left.
 *
 * `unvisitedRoute` is the route cells the round has still not entered; `decayLeft` is the units it has
 * left to spend; `distanceToTarget` is how far along the route it stands; `batchDepth` is the depth it
 * has been averaging.
 *
 * The verdict is `U > 4u`, and it is monotone by construction: `U` falls by at most four per turn - see
 * NEW_CELLS_PER_TURN_CAP - while `u` falls by at least one, so `U/4 - u` never decreases and a run that
 * is lost stays lost.
 *
 * Distance is deliberately kept out of it. A retreat out of a dead end cuts the distance by several cells
 * for one unit, so a distance rule switches off again and a report built on it flaps: on one real run it
 * turned on and off five times around turn 322. `U` cannot fall on a retreat, because the cells retraced
 * were already entered - which is exactly why it is the quantity the verdict rests on.
 *
 * Every flag is false where the budget was never reported: an unmeasured unit is not a finding. */
export function survivalFlags({
  unvisitedRoute,
  decayLeft,
  distanceToTarget,
  batchDepth,
}: {
  unvisitedRoute: number;
  decayLeft: number | null;
  distanceToTarget: number | null;
  batchDepth: number | null;
}): SurvivalFlags {
  if (decayLeft === null) {
    return {lost: false, behindObservedPace: false, beyondDecayLeft: false, beyondOwnPace: false};
  }

  return {
    lost: unvisitedRoute > NEW_CELLS_PER_TURN_CAP * decayLeft,
    behindObservedPace: unvisitedRoute > FASTEST_SUSTAINED_PACE * decayLeft,
    beyondDecayLeft: distanceToTarget !== null && distanceToTarget > decayLeft,
    beyondOwnPace:
      distanceToTarget !== null && batchDepth !== null && distanceToTarget > batchDepth * decayLeft,
  };
}

// --- The run, turn by turn ---

/** What one turn did with the ground it stood on.
 *
 * The three no-progress classes are the reason this exists. Tapoo charges one unit for a turn that
 * entered no new cell, whichever kind it was, so the budget cannot tell them apart - and one of them is
 * what the prompt asks for at a confirmed dead end while another is a rubric violation. A rate that pools
 * them reports a violation where there was compliance: one real run's 301 no-progress turns are 294
 * oscillations and 7 retreats, and another's 59 are retreats and nothing else - it lost doing exactly
 * what it was told to do.
 *
 * `unclassified` is a no-progress turn whose cells the log never graded. Named rather than folded into
 * either side: a grade this module inferred would be a grade nothing could check. */
export type TurnProgress = "advanced" | "still" | "retreat" | "oscillation" | "unclassified";

/** One turn of a round's run, with where it stood and what that meant. */
export type SurvivalTurn = SurvivalFlags & {
  turn: number;
  /** Route cells nobody had entered once this turn ended - the monotone quantity. */
  unvisitedRoute: number;
  decayLeft: number | null;
  /** Route distance from the cell it stood on. Diagnostic: a retreat cuts it, so it is never a verdict. */
  distanceToTarget: number | null;
  progress: TurnProgress;
  /** The maze refused a move this turn could otherwise have made. */
  wallContact: boolean;
};

/** A round's whole run, and the first turn each finding held from. */
export type SurvivalOutlook = {
  routeCells: number;
  visitedRouteCells: number;
  series: SurvivalTurn[];
  /** The first turn from which the destination was already out of reach, or null for a run that always
   * had a way to finish. Monotone, so "from" is exact rather than "at some point". */
  lostFrom: number | null;
  /** Turns whose budget the log actually reported.
   *
   * Zero means every finding below it is false for want of a reading, not true: `lostFrom` is null there
   * because nothing could be tested, and a reader told "within reach throughout" on that basis would be
   * given a reassurance drawn from no evidence. survivalVerdict refuses it. */
  budgetTurns: number;
  behindObservedPaceFrom: number | null;
  beyondDecayLeftFrom: number | null;
  beyondOwnPaceFrom: number | null;
  retreats: number;
  oscillations: number;
  unclassified: number;
  wallContacts: number;
};

/** A turn as this module reads one: what it entered, what it was charged, and what it stood on after. */
export type SurvivalInputTurn = {
  turn: number;
  /** The cells the turn walked, opening with the cell it started on - TurnSummary.cells. */
  cells: readonly string[];
  /** Moves that landed, and the moves the maze could read. Their difference is a refused move. */
  applied: number | null;
  applicable: number;
  decayRemaining: number | null;
};

/** survivalSeries walks a round's turns in order and reports where each left it.
 *
 * `route` is the ordered cells from the round's start to the destination, `distances` every cell's moves
 * from the destination, `statusesAt` the grades Tapoo put on cells as of a turn, and `batchDepth` the
 * depth the round averaged - the one figure here that describes the whole run rather than a turn.
 *
 * Every turn of the round, whoever played it: one budget is drawn down by whoever moves, and a route cell
 * entered by one seat is entered for the round, so a second seat continues the walk rather than starting
 * one of its own.
 *
 * Null where there is no route to measure against: a round that stated no destination has no unvisited
 * route to count, and a round with no turns has nothing to say. Neither is a run that was doing fine. */
export function survivalSeries({
  turns,
  route,
  distances,
  statusesAt,
  batchDepth,
}: {
  turns: readonly SurvivalInputTurn[];
  route: readonly string[] | null;
  distances: ReadonlyMap<string, number>;
  statusesAt: (turn: number) => ReadonlyMap<string, string> | undefined;
  batchDepth: number | null;
}): SurvivalOutlook | null {
  if (!route || route.length === 0 || turns.length === 0) {
    return null;
  }

  const routeCells = new Set(route);
  // The cell the first turn stands on before it moves is a cell entered - the same start-square reasoning
  // agentsFromRound applies when it counts cells from `cells.slice(1)`.
  const visited = new Set<string>();
  const standing = turns[0]?.cells[0];
  if (standing !== undefined) visited.add(standing);

  const series: SurvivalTurn[] = [];
  let cell = standing;
  let retreats = 0;
  let oscillations = 0;
  let unclassified = 0;
  let wallContacts = 0;

  for (const turn of turns) {
    const entered = turn.cells.slice(1);
    const statuses = statusesAt(turn.turn);
    const newCells = entered.filter((one) => !visited.has(one));
    for (const one of entered) visited.add(one);
    if (entered.length > 0) cell = entered.at(-1);

    const progress = progressOf(entered, newCells, statuses);
    if (progress === "retreat") retreats += 1;
    if (progress === "oscillation") oscillations += 1;
    if (progress === "unclassified") unclassified += 1;

    // A move the maze refused, which is not the same finding as a command it could not read: an
    // unreadable command is the model spelling a move wrong, and the rubric already reports that against
    // the prediction. This is the wall - the turn had a move it could have made and the maze said no.
    const wallContact = turn.applied !== null && turn.applied < turn.applicable;
    if (wallContact) wallContacts += 1;

    const unvisitedRoute = countUnvisited(routeCells, visited);
    series.push({
      turn: turn.turn,
      unvisitedRoute,
      decayLeft: turn.decayRemaining,
      distanceToTarget: cell === undefined ? null : distances.get(cell) ?? null,
      progress,
      wallContact,
      ...survivalFlags({
        unvisitedRoute,
        decayLeft: turn.decayRemaining,
        distanceToTarget: cell === undefined ? null : distances.get(cell) ?? null,
        batchDepth,
      }),
    });
  }

  const from = (flag: keyof SurvivalFlags): number | null =>
    series.find((one) => one[flag])?.turn ?? null;

  return {
    routeCells: route.length,
    visitedRouteCells: route.length - countUnvisited(routeCells, visited),
    series,
    lostFrom: from("lost"),
    budgetTurns: series.filter((one) => one.decayLeft !== null).length,
    behindObservedPaceFrom: from("behindObservedPace"),
    beyondDecayLeftFrom: from("beyondDecayLeft"),
    beyondOwnPaceFrom: from("beyondOwnPace"),
    retreats,
    oscillations,
    unclassified,
    wallContacts,
  };
}

// countUnvisited counts the route cells the round has still to enter.
const countUnvisited = (route: ReadonlySet<string>, visited: ReadonlySet<string>): number => {
  let count = 0;
  for (const cell of route) {
    if (!visited.has(cell)) count += 1;
  }
  return count;
};

// progressOf grades what a turn did with the cells it entered.
//
// The grade belongs to the cell the turn *entered*, which is how visitStatusAfterTurn is built - Tapoo
// states a status per open move, and the status describes where that move leads. Reading the cell a turn
// left would grade the ground behind it.
//
// Tapoo grades a cell by its visit count against its open-exit count, as its own prompt sets out:
// `explored` is below that count, `backtracking` is equal to it - "this direction is spent" - and a dead
// end goes to `backtracking` on its first visit and `oscillating` when it is entered again after that. So
// an `oscillating` cell is one the run has already been through and exhausted, and a turn that enters only
// such cells is withdrawing back out of a region it has finished with: a **retreat**. A turn that enters
// cells still carrying unspent exits, gaining no ground by it, is **oscillating** between live options -
// which is the rubric violation of the two, where the retreat is what the prompt asks for at a confirmed
// dead end.
//
// Measured on the deepseek-v4-pro capture: 292 retreats against 7 oscillations over its 301 no-progress
// turns, with 2 more left ungraded.
function progressOf(
  entered: readonly string[],
  newCells: readonly string[],
  statuses: ReadonlyMap<string, string> | undefined,
): TurnProgress {
  if (entered.length === 0) {
    return "still";
  }
  if (newCells.length > 0) {
    return "advanced";
  }

  const graded = entered.map((cell) => statuses?.get(cell));
  if (graded.some((status) => status === "oscillating")) {
    return "retreat";
  }
  // Every cell graded, and every grade one that still had an exit to spend. A turn with an ungraded cell
  // says so rather than joining whichever side happens to be reported next to it.
  if (graded.every((status) => status === "backtracking" || status === "explored")) {
    return "oscillation";
  }

  return "unclassified";
}
