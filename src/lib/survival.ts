// What a run spent, against what the maze costs.
//
// A round begins with one decay unit per cell of the maze and spends at least one per turn, so the whole
// of a run's story can be told in that one unit: what it paid for its errors, what it earned back by
// batching moves, and whether what remained could still reach the destination. This module is the
// arithmetic of that account, and the rule for when a run could no longer finish.
//
// Its own module rather than geometry.ts, which holds the derivations a maze admits on its own: these
// read a round - its turns, its seats, the grades Tapoo put on the cells they entered. And not
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

/** decayLedger splits what a seat spent into the three terms that caused it.
 *
 * `cells` is the maze's cell count, which is also the round's opening budget; `decayCharged` is what the
 * seat was charged over the round; `played` is every turn it took and every move that landed.
 *
 * Null rather than zeros wherever the account cannot be drawn: a seat with no turns, no moves or no
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
 * `unvisitedRoute` is the route cells the seat has still not entered; `decayLeft` is the units it has
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
