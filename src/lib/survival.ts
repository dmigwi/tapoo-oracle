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

import {decomposeTraversalSpeed} from "./geometry";
import type {
  AgentSummary,
  SurvivalDecomposition,
  SurvivalFlags,
  SurvivalInputTurn,
  SurvivalSummary,
  SurvivalTurn,
  TurnProgress,
} from "./types";

// --- Decomposing what a round spent ---

/** decomposeSurvival splits whether a round could survive its mistakes into the terms that decide it.
 *
 * `cells` is the maze's cell count, which is also the round's opening budget; `decayCharged` is what the
 * round was charged; `settled` is the speed decomposition's population - the turns that stated both an
 * applied count and a charge, or the round's authoritative totals where it finished. Both are the round's,
 * added across its seats, because the budget is one pool for the round and every active agent spends from
 * it.
 *
 * Whether that population speaks for the round is the caller's question, not this one's: survivalDecomposi-
 * tionFor refuses a round whose readings have holes in the middle. An unfinished round is not such a round
 * - it is the case the account exists for, since a run can oscillate its way to a certain loss and stop
 * before the loss is recorded.
 *
 * Null rather than zeros wherever the account cannot be drawn: a round whose speed does not decompose has
 * no depth to judge, and a zero would read as a measurement. Null too where the charge is below one
 * per turn, which is a log disagreeing with itself rather than a run that found a discount -
 * roundTotalsCheck is where that is reported. */
export function decomposeSurvival({
  cells,
  decayCharged,
  settled,
}: {
  cells: number;
  decayCharged: number | null;
  settled: AgentSummary["settled"];
}): SurvivalDecomposition | null {
  // The depth comes from the speed decomposition, never from a second division here: `b` is one metric,
  // and a report that computed it twice could show a card and a table disagreeing about the same seat.
  // That also fixes the population - the turns that settled both an applied count and a charge - so every
  // term below is counted over the turns the depth was measured on.
  const speed = decomposeTraversalSpeed({settled, decayCharged});
  if (speed === null || settled === null || decayCharged === null) {
    return null;
  }

  const errorDebt = decayCharged - settled.turnsTaken;
  // A budget the errors already exhausted leaves no depth that could have covered the maze, and the
  // division below would answer with a sign rather than a depth.
  if (errorDebt < 0 || cells - errorDebt <= 0) {
    return null;
  }

  const routeSlack = cells - settled.movesApplied;
  const batchCredit = settled.movesApplied - settled.turnsTaken;
  return {
    errorDebt,
    batchDepth: speed.batching,
    routeSlack,
    batchCredit,
    // The sum, not the formula: at the depth achieved, moves/b is exactly the turns taken, so
    // A - moves/b - p and slack + credit - p are the same integer - and summing the reported terms keeps
    // it one, where the division would leave a figure that prints as 2.9999999999999996.
    headroom: routeSlack + batchCredit - errorDebt,
    neededDepth: settled.movesApplied / (cells - errorDebt),
  };
}

// --- When a run could no longer finish ---

/** The most cells a turn can enter for the first time, where the round never stated its history window.
 *
 * The round's own figure is the one to use: a turn can only discover ground the agent can see, so Tapoo's
 * history window radius is the ceiling, and a round that ran with a radius of 2 has a cap of 2. Callers
 * pass that radius; this is the fallback for the older shapes that state none.
 *
 * The mechanism, which is why the radius is the right figure rather than a coincidence: the first new cell
 * of a turn is free, because the current cell's openMoves names it. The second needs the exits of a cell
 * not yet visited, deduced from the window. Each further new cell needs another layer of deduction, and a
 * Manhattan radius supplies about that many layers.
 *
 * It bounds discovery only, never batch length. A retreat through visited ground needs no deduction at all
 * - at radius 4 the window can hold 25 cells whose exits are already known - so retreat batches run long,
 * and one run applied seven moves in a turn that entered a single new cell. That is why the verdict counts
 * unvisited route cells and never distance: a long retreat cuts distance sharply while U cannot fall.
 *
 * Measured, not assumed: across the twelve captures to hand on 2026-09-28, 2,377 turns with a resolvable
 * replay start entered 0, 1, 2, 3 or 4 new cells - 615, 1,548, 189, 22 and 3 turns of each - and none
 * entered a fifth. Every round that stated a window of 4 stayed at or under 4, and the one that stated 2
 * stayed at or under 2.
 *
 * The cap is what makes the verdict monotone. One set too high only makes the verdict slower to fire,
 * never wrong - which is why the fallback is the largest window the captures show rather than the
 * smallest.
 *
 * Empirical and mechanistic, not structural: the response schema sets minItems 1 with no maximum, so a
 * longer batch is permitted and a chain forced by boundary walls could in principle deduce a fifth new
 * cell. It has not yet, and the window explains why - which is a measured ceiling with a date on it,
 * revisable the day a run shows five. */
export const NEW_CELLS_PER_TURN_CAP = 4;

/** The fastest pace any sampled run has sustained, as a record to be beaten rather than a law.
 *
 * Derived from one run: glm-5.3 at level 54, which held a batch depth of 1.524 moves a turn against the
 * 1.126 the route demanded of it - a margin of +0.398, the widest in the sample. gemma4 on the same maze
 * held 1.205 against 0.985. Carried at full precision rather than rounded: the threshold is that run's
 * figure, and trimming it would put the bar somewhere no run actually reached.
 *
 * A warning threshold and never a verdict: a run beating it is a new record, not an error, and the number
 * is meant to be raised when one does. To re-derive it, take the highest sustained batch depth in the
 * sampled logs and put it here in full.
 *
 * Two things about it that a future updater should weigh before moving it:
 *
 *   1.524 rests on an estimated move count. The framework's own figures estimate moves as `P + 2X` - each
 *   explored off-path cell entered and left once - which gives glm-5.3 544 moves and gemma4 582. A run
 *   that oscillates walks more than the estimate, so the estimate runs low. This replay measures them
 *   instead, at 615 and 603, which puts that run's achieved depth at 1.7227 rather than 1.524. The
 *   framework says the replay's figure is the one to use; this threshold has not been re-derived from it.
 *
 *   The quantity it is compared against is new *route cells* per decay unit, not moves per turn, and no
 *   sampled run has sustained above 1.0588 of those - 0.8354 on the 600-cell mazes. A threshold taken
 *   from batch depth is therefore looser than the ground it judges, which makes the warning quiet rather
 *   than wrong. */
export const FASTEST_SUSTAINED_PACE = 1.524;

/** survivalFlags reads one turn's position against the budget it has left.
 *
 * `unvisitedRoute` is the route cells the round has still not entered; `decayLeft` is the units it has
 * left to spend; `distanceToDestination` is how far along the route it stands; `batchDepth` is the depth it
 * has been averaging.
 *
 * The verdict is `U > cu`, where `c` is the round's ceiling on discovery - its history window radius, or
 * NEW_CELLS_PER_TURN_CAP where it stated none. It is monotone by construction: `U` falls by at most `c`
 * per turn while `u` falls by at least one, so `U/c - u` never decreases and a run that is lost stays
 * lost. The ceiling is fixed for a round, which is what the argument needs - a cap that moved mid-round
 * could switch the verdict off again.
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
  distanceToDestination,
  batchDepth,
  newCellsPerTurnCap = NEW_CELLS_PER_TURN_CAP,
}: {
  unvisitedRoute: number;
  decayLeft: number | null;
  distanceToDestination: number | null;
  batchDepth: number | null;
  /** The round's own ceiling on discovery - its history window radius. Defaults to the measured fallback
   * for a round that stated none. */
  newCellsPerTurnCap?: number | null;
}): SurvivalFlags {
  if (decayLeft === null) {
    return {lost: false, behindObservedPace: false, beyondDecayLeft: false, beyondOwnPace: false};
  }

  return {
    lost: unvisitedRoute > (newCellsPerTurnCap ?? NEW_CELLS_PER_TURN_CAP) * decayLeft,
    behindObservedPace: unvisitedRoute > FASTEST_SUSTAINED_PACE * decayLeft,
    beyondDecayLeft: distanceToDestination !== null && distanceToDestination > decayLeft,
    beyondOwnPace:
      distanceToDestination !== null && batchDepth !== null && distanceToDestination > batchDepth * decayLeft,
  };
}

// --- The run, turn by turn ---

/** survivalSeries walks a round's turns in order and reports where each left it.
 *
 * `route` is the ordered cells from the round's start to the destination, `distanceFromDestination` every
 * cell's moves from it, `statusesAt` the grades Tapoo put on cells as of a turn, and `batchDepth` the
 * depth the round averaged, and `newCellsPerTurnCap` the round's own ceiling on discovery.
 *
 * Every turn of the round, whoever played it: one budget is drawn down by whoever moves, and a route cell
 * entered by one seat is entered for the round, so a second seat continues the walk rather than starting
 * one of its own.
 *
 * Null where there is no route to measure against: a round that stated no destination has no unvisited
 * route to count, and that is not a run that was doing fine.
 *
 * A round with no turns is not null, though. It covered none of the route, which is a measurement and reads
 * as one - where "not recorded" belongs to the round whose route was never computed. Its series is empty,
 * so every finding below refuses for want of a reading rather than answering. */
export function survivalSeries({
  turns,
  route,
  distanceFromDestination,
  statusesAt,
  batchDepth,
  newCellsPerTurnCap,
}: {
  turns: readonly SurvivalInputTurn[];
  route: readonly string[] | null;
  distanceFromDestination: ReadonlyMap<string, number>;
  statusesAt: (turn: number) => ReadonlyMap<string, string> | undefined;
  batchDepth: number | null;
  /** The round's history window radius: the most cells one turn could enter for the first time, because a
   * turn can only discover ground the agent can see. Null where the round stated none, which falls back to
   * NEW_CELLS_PER_TURN_CAP. */
  newCellsPerTurnCap?: number | null;
}): SurvivalSummary | null {
  if (!route || route.length === 0) {
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
      distanceToDestination: cell === undefined ? null : distanceFromDestination.get(cell) ?? null,
      progress,
      wallContact,
      ...survivalFlags({
        unvisitedRoute,
        decayLeft: turn.decayRemaining,
        distanceToDestination: cell === undefined ? null : distanceFromDestination.get(cell) ?? null,
        batchDepth,
        newCellsPerTurnCap,
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
