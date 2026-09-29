// The maze replay's own model: one round turned into something drawable.
//
// The replay shapes its own data rather than drawing on report-adapters, which shapes the report's. The
// two answer to different readers - a grid and a scrubber against a table of verdicts - and the rule
// that adapters live in one module was costing a reach into a file about reports for functions only the
// maze calls.
//
// Pure and document-free, which is why it is tested in node while the view beside it needs jsdom.

import { mazeFromEncoded, routeFrom } from "./maze"
import { decayLedger, survivalSeries } from "./survival"
import { clamp, formatCount } from "./utils"
import type { AgentSummary, CellKey, Frame, PlayedRound, ReplayModel, SummaryRow, TurnSummary, VisitStatus } from "./types"
import type { DecayLedger, SurvivalOutlook } from "./survival"

// --- Entry point: what maze-view calls ---

/** mazeReplayModel turns one round into everything the maze view needs, or the reason it cannot be
 * drawn. Null for a report that answered no round.
 *
 * Takes the round rather than the report holding it: the replay draws a maze, and a verdict is not one
 * of its inputs.
 *
 * The maze is not optional context: a traversal drawn on a grid that failed its checksum would be a
 * picture of damaged bytes presented as evidence. So a round that cannot be decoded carries an error
 * instead of a partial grid, and the view renders the error. */
export function mazeReplayModel(round: PlayedRound | null | undefined): ReplayModel | null {
  if (!round) return null;

  // The destination arrives already resolved to a cell key: one reader in the contract handles both
  // logged shapes, for every field carrying a cell. Converting here instead means handling {row, col}
  // and turning a compacted [row, col] into "undefined,undefined" - no destination drawn, and
  // "no route found" reported as evidence.
  const destination = round.destinationCell;
  const built = mazeFromEncoded(round.encodedMaze, {
    startCell: round.startCell,
    destinationCell: destination
  });

  return {
    identity: round.identity,
    maze: built.ok ? built.maze : null,
    error: built.ok ? null : built.error,
    stats: built.ok ? built.stats : null,
    routes: built.ok ? built.routes : null,
    startCell: round.startCell,
    destinationCell: destination,
    endCell: round.endCell,
    observedExits: round.observedExits,
    visitStatusAfterTurn: round.visitStatusAfterTurn,
    historyWindowRadius: round.historyWindowRadius,
    turns: round.turns,
    outcome: round.outcome,
    agents: round.agents
  };
}

/** routeCells reads the round's start-to-destination route, or null where there is none to read.
 *
 * From the walk mazeFromEncoded already did, so nothing here searches the maze a second time. Null where
 * the round stated no destination, where the maze did not decode, or where the start is not on it. */
export function routeCells(model: ReplayModel | null | undefined): CellKey[] | null {
  if (!model?.routes) return null

  return routeFrom(model.routes, model.startCell)
}

/** sharesOneBudget reports whether the round's decay readings can be read as the maze's.
 *
 * They can where one seat played it, and only there. Tapoo's own tool description calls
 * decayUnitsRemaining "the maximum number of decay units *the player* can spend", and its round-end entry
 * states `playerUniqueCellsVisited` beside `allUniqueCellsVisited` - a maze several players walk gives each
 * of them their own budget and their own position. Pooled across two of those, `u` would be whichever
 * player reported last and `b_min` would divide by one budget where the round opened with two: a verdict
 * that could call a round lost while the other seat still had the units to finish it.
 *
 * Every round in the twelve captures on disk seated one player, so this guards a shape none of them takes.
 * It refuses rather than guesses, because the figure it would otherwise print is the one a reader would
 * trust most. */
function sharesOneBudget(model: ReplayModel): boolean {
  return model.agents.length <= 1
}

/** survivalOutlookFor reads the round's run against that route: what the maze had still to be entered,
 * what budget was left, and the first turn from which the destination was already out of reach.
 *
 * Per round, not per seat, because every term in it belongs to the maze. One decay budget is drawn down by
 * whoever moves, and a route cell a seat enters is entered for the round - the next seat inherits the
 * ground rather than starting again on it. Split per seat, the same maze would answer one question several
 * times and no answer would be about the maze.
 *
 * Null where there is no route to measure against, or where the round played no turn. */
export function survivalOutlookFor(model: ReplayModel | null | undefined): SurvivalOutlook | null {
  const route = routeCells(model)
  if (!model?.routes || !route) return null

  const budgeted = sharesOneBudget(model)
  const ledger = survivalLedgerFor(model)
  return survivalSeries({
    turns: model.turns.map((turn) => ({
      turn: turn.turn,
      cells: turn.cells,
      applied: turn.applied,
      // What the maze could read of what the turn asked for. TurnSummary.moves is already narrowed to
      // that prefix, so the difference from `applied` is the wall and nothing else.
      applicable: turn.moves.length,
      // Withheld where the round seated more than one player, because then it is one player's budget and
      // not the round's. Every finding that reads it refuses on a null, which is the answer wanted here -
      // the ground covered and the no-progress split are still the round's and still counted.
      decayRemaining: budgeted ? turn.decayRemaining : null,
    })),
    route,
    distances: model.routes.distances,
    statusesAt: (turn) => model.visitStatusAfterTurn.get(turn),
    batchDepth: ledger?.batchDepth ?? null,
  })
}

/** survivalLedgerFor splits what the round spent into the terms that caused it, or null where the round
 * did not measure enough of it. The maze's cell count is the round's opening budget.
 *
 * The seats' charges and counts added together, for the same reason the outlook pools their turns: the
 * budget is the maze's, and a seat that spends half of it leaves the other half for the rest of the table.
 * Charges add the way agentsFromRound gathers them - the seats that stated one, and null where none did. */
export function survivalLedgerFor(model: ReplayModel | null | undefined): DecayLedger | null {
  // No ledger for a round several players shared: `b_min` divides by the budget the round opened with, and
  // a maze walked by two players opens with two of them. See sharesOneBudget.
  if (!model?.stats || !sharesOneBudget(model)) return null

  let decayCharged: number | null = null
  for (const agent of model.agents) {
    if (agent.decayCharged !== null) decayCharged = (decayCharged ?? 0) + agent.decayCharged
  }

  return decayLedger({cells: model.stats.cells, decayCharged, played: roundPlayed(model)})
}

/** roundPlayed adds up what every seat played, or null where no seat played a turn.
 *
 * Added rather than taken from the turn list, so the one accumulation agentsFromRound already vetted is the
 * only one: the winning turn's moves reach a seat's count through an inference the raw turns do not carry. */
export function roundPlayed(model: ReplayModel | null | undefined): AgentSummary["played"] {
  let total: AgentSummary["played"] = null
  for (const agent of model?.agents ?? []) {
    if (!agent.played) continue
    const sum: NonNullable<AgentSummary["played"]> = total ?? {turnsTaken: 0, movesApplied: 0, movesUnreported: 0}
    total = {
      turnsTaken: sum.turnsTaken + agent.played.turnsTaken,
      movesApplied: sum.movesApplied + agent.played.movesApplied,
      movesUnreported: sum.movesUnreported + agent.played.movesUnreported,
    }
  }

  return total
}

/** agentIndexOf resolves a turn to the seat that played it, as an index into `agents`, or -1 for a turn
 * no seat claims.
 *
 * By the stated seat first and the name second, which is how agentsFromRound gathers these records -
 * resolving them differently here would colour a trail for a seat the table does not list. The name
 * still has to work on its own: a legacy log states no seat on any turn, and the one
 * seatId such a log carries reaches the record from the round-end entry, so the seat matches nothing and
 * the name is all there is.
 *
 * An index rather than a name, because a name is not an identity. Two seats that stated a number and no
 * player both answer to "", and keyed by that they would share one trail, one colour and one marker -
 * drawn as a single agent that walked both paths. */
export function agentIndexOf(
  agents: readonly AgentSummary[],
  turn: {seatId: number | null; playerName: string | null},
): number {
  if (turn.seatId !== null) {
    const stated = agents.findIndex((agent) => agent.seatId === turn.seatId);
    if (stated >= 0) return stated;
  }
  if (turn.playerName === null) return -1;
  return agents.findIndex((agent) => agent.name === turn.playerName);
}

/** mazeFrameAt reports the state of the replay after `turnIndex` turns have been played.
 *
 * Pure, and the only thing the scrubber calls: keeping the frame a value rather than mutating the view
 * means every position it can show is reachable in a test without a browser. */
export function mazeFrameAt(levelModel: ReplayModel, turnIndex: number): Frame {
  const played = levelModel.turns.slice(0, clamp(turnIndex, 0, levelModel.turns.length));

  // The status each cell last carried as of this frame.
  //
  // The map is keyed by the turn whose end a payload reports, so the bound is simply the last
  // turn played - and -1 when none has been, which is the state the round opened in. Reading it any
  // other way is what made the colours lag: bounded by the turn that *carried* the payload, every frame
  // showed the world one turn before the one it was drawing.
  //
  // Statuses are reported only for cells inside that turn's history window, and the three payloads are
  // model-triggered tool calls that a turn may not carry at all, so a cell keeps the last thing said
  // about it until something says otherwise. Last one wins.
  const statuses = new Map<CellKey, VisitStatus>();
  const upTo = played.at(-1)?.turn ?? -1;
  for (const [turn, reported] of levelModel.visitStatusAfterTurn.ascending()) {
    if (turn > upTo) break;
    for (const [cell, status] of reported) statuses.set(cell, status);
  }

  // The start square is occupied before a single move, so it is never "awaiting" anything - but at frame
  // 0 no payload has graded it yet. Tapoo's window at turn 0 holds only that square, and a cell is
  // graded by a *neighbour* pointing back at it, so the first grade arrives on turn 1 once the agent has
  // stepped off.
  //
  // Backfilling that first grade to the earlier frames is a read, not a guess, and only here. A cell's
  // grade is a function of how many times it has been entered, and the start square cannot be re-entered
  // without the agent first leaving and returning - which takes moves, which is what produces the very
  // payload being read. So the first grade any payload gives the start square is the grade it had from
  // the outset. That argument holds for no other cell, which is why this is not a general rule.
  const start = levelModel.startCell;
  if (start !== null) {
    const known = statuses.get(start);
    if (known === undefined || known === "unvisited") {
      for (const [, reported] of levelModel.visitStatusAfterTurn.ascending()) {
        const first = reported.get(start);
        if (first !== undefined && first !== "unvisited") {
          statuses.set(start, first);
          break;
        }
      }
    }
  }

  const visited = new Map<CellKey, {playerName: string | null; status: VisitStatus | null}>();
  const enter = (cell: CellKey, playerName: string | null): void => {
    // null means the log never graded this cell, and the view draws that as its own mark rather than
    // guessing. Answering "explored" would be a grade Tapoo never issued - the weakest rung of the scale
    // is still a rung, and inventing one is the thing this report must not do.
    //
    // Two ways a walked cell has no usable grade. No payload ever named it: get_maze_structure is a
    // tool the model chooses to call, so a cell can be walked in a turn that never asked. Or the newest
    // reading still says "unvisited", which our own walk contradicts - true when it was written, and
    // stale by the time the agent stepped in. Neither is a measurement.
    //
    // A cell that was never entered is not in this map at all: it has no rect, and shows the paper.
    const reported = statuses.get(cell);
    visited.set(cell, {playerName, status: reported === undefined || reported === "unvisited" ? null : reported});
  };

  if (levelModel.startCell) enter(levelModel.startCell, null);
  for (const turn of played) {
    for (const cell of turn.cells) enter(cell, turn.playerName);
  }

  const current = played.at(-1);
  const positions = new Map<number, CellKey>();
  for (const turn of played) {
    const last = turn.cells.at(-1);
    const seat = agentIndexOf(levelModel.agents, turn);
    if (seat >= 0 && last) positions.set(seat, last);
  }

  return {
    // The turns this frame covers. Returned rather than recomputed by the caller: drawFrame needed the
    // whole level model purely to slice this same range again.
    played,
    turnIndex: played.length,
    totalTurns: levelModel.turns.length,
    visited,
    positions,
    currentCell: current?.cells.at(-1) ?? levelModel.startCell ?? null,
    // The wall the agent walked into on this turn, if any. Drawn only for the current turn: a rejected
    // move is an event, not a lasting property of the cell.
    rejected: current?.rejectedMove
      ? {cell: current.cells.at(-1) ?? null, move: current.rejectedMove}
      : null,
    turn: current ?? null
  };
}

/** The most a turn can be charged: Tapoo's own ceiling.
 *
 * Three is charged only when lastSubmittedMoves is empty - a malformed response, an exhausted token
 * cap, or a failed request. */
export const MOST_DECAY = 3;

/** How a round's turns divide across the three charges, plus the turns no reading covered. */
export type DecayTally = {
  /** One entry per charge the round actually incurred, ascending. A charge that never happened is
   * absent rather than zero: naming a penalty nobody paid describes the rules, not the run. */
  counts: Array<{charge: number; count: number}>;
  /** Turns whose charge no reading settled. Not zero-cost turns - unmeasured ones. */
  unreported: number;
};

/** decayTally counts turns by what they were charged.
 *
 * Takes the turns rather than the level, because the two callers mean different sets of them: the Turns
 * row in the level summary counts the whole round, and the legend under the scrubber counts only what
 * has been played. One function, so the two can never disagree about how a charge is classified - only
 * about which turns they are asking about. */
export function decayTally(turns: readonly TurnSummary[]): DecayTally {
  const counts = new Map<number, number>();
  let unreported = 0;

  for (const turn of turns) {
    if (turn.decayCharged === null) {
      unreported += 1;
      continue;
    }
    const charge = Math.min(turn.decayCharged, MOST_DECAY);
    counts.set(charge, (counts.get(charge) ?? 0) + 1);
  }

  return {
    counts: [...counts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([charge, count]) => ({charge, count})),
    unreported,
  };
}

// term writes a ledger figure with the sign it carries, because a ledger's terms are credits and debts and
// "1 slack" reads as a quantity where "+1 slack" reads as the direction it pushed.
function term(value: number): string {
  return value > 0 ? `+${formatCount(value)}` : formatCount(value);
}

// batchDepthOf writes the depth the round reached beside the depth the route still demanded of it.
//
// Not the decomposition's `b`, though it measures the same thing: that one divides the turns that settled
// both an applied count and a charge, and this one every turn played. Two denominators under one letter
// would read as one figure printed twice, so this one carries its counts instead.
function batchDepthOf(ledger: DecayLedger, played: AgentSummary["played"]): string {
  const depth = (value: number): string => value.toFixed(4);
  const margin = ledger.batchDepth - ledger.neededDepth;
  const standing = margin >= 0 ? `surplus ${depth(margin)}` : `short by ${depth(-margin)}`;

  // A turn whose applied count nothing settled still counts as a turn and contributes no moves, so where
  // there are any, the moves are a floor and the depth with them. Said rather than left for the reader to
  // work out: the row is a ratio, and a ratio quietly missing part of its numerator is the one shape of
  // wrong figure that looks exactly like a right one.
  const unreported = played?.movesUnreported ?? 0;
  const floor = unreported > 0 ? "at least " : "";
  const counts =
    played === null
      ? ""
      : ` (${formatCount(played.movesApplied)} moves${unreported > 0 ? ` over ${formatCount(played.turnsTaken - unreported)} of ` : " / "}` +
        `${formatCount(played.turnsTaken)} turns${unreported > 0 ? `, ${formatCount(unreported)} never reported` : ""})`;

  return `${floor}${depth(ledger.batchDepth)}${counts} \u00b7 needed ${depth(ledger.neededDepth)} (${standing})`;
}

/** survivalVerdict states the one thing the decay budget settles: whether the destination was still inside
 * what the budget could reach.
 *
 * Two answers and no more, and nothing at all where the round stated no destination - there is no route to
 * be out of reach of, and silence is the honest answer rather than "within reach". Never a pace warning:
 * those are a different claim in a different vocabulary, and each of them describes a run that can still
 * recover. This one cannot switch off once it holds. */
export function survivalVerdict(outlook: SurvivalOutlook | null): {text: string; lost: boolean} | null {
  // Nothing at all where no turn reported a budget. The rule cannot hold without one, so `lostFrom` is null
  // there for want of a reading rather than because the destination stayed in reach - and "within reach
  // throughout" off the back of that is the same measured-looking zero as a success path of "0 of 70".
  if (!outlook || outlook.budgetTurns === 0) return null;

  return outlook.lostFrom === null
    ? {text: "Within reach throughout: the destination stayed inside what the decay could reach.", lost: false}
    : {
        text: `Could not finish from turn ${formatCount(outlook.lostFrom)}: more route cells left than the decay could reach.`,
        lost: true,
      };
}

/** finalScore reads the score the round ended on, or null where nothing stated one.
 *
 * The entry that closed the round states it, and an unfinished round has no such entry - so the fallback is
 * the last turn that reported a score, which is Tapoo's own figure "after that outcome" for the last turn
 * anything was reported for. Later turns that reported nothing cannot lower it and do not stand in for it.
 *
 * Null rather than 0 where no reading states one, because 0 is a score a round can genuinely end on: it is
 * what the two rounds that ended at a standstill in the captures both recorded. */
export function finalScore(levelModel: ReplayModel | null | undefined): number | null {
  if (!levelModel) return null

  const stated = levelModel.outcome?.score
  if (typeof stated === "number" && Number.isFinite(stated)) return stated
  if (typeof stated === "string" && stated.trim() !== "" && Number.isFinite(Number(stated))) return Number(stated)

  for (let index = levelModel.turns.length - 1; index >= 0; index--) {
    const score = levelModel.turns[index]?.score
    if (typeof score === "number") return score
  }

  return null
}

/** mazeSurvivalRows reads the round against the maze's own budget: what it spent, what that left it, and
 * whether the destination was still inside what remained.
 *
 * Its own table rather than columns on a seat's card, because every term in it belongs to the maze. A round
 * opens with one decay unit per cell and spends at least one a turn, so one budget is drawn down by whoever
 * moves and one route is covered by whoever walks it. Split per seat, the same maze would answer one
 * question several times over and no answer would be about the maze.
 *
 * Every row reads "not recorded" rather than a zero where the round did not measure it: a log that stated no
 * destination has no route to fall short of, and a measured-looking 0 is the one answer that would be wrong. */
export function mazeSurvivalRows(levelModel: ReplayModel | null | undefined): SummaryRow[] {
  if (!levelModel?.stats) return [];

  const ledger = survivalLedgerFor(levelModel);
  const outlook = survivalOutlookFor(levelModel);

  return [
    // First, because it is what every row under it is evidence for: a round can be lost long before it stops,
    // and this says from which turn the stopping was already settled. A reader's figure after the fact - it
    // needs the decoded maze - so it never claims the round knew.
    {field: "Point of no return", value: survivalVerdict(outlook)?.text ?? "not recorded"},
    // How much of the route the round actually covered, against the route's own length.
    //
    // Not cells entered over the maze's area, which is the figure this replaces: that one is bounded by
    // how many dead ends a maze happens to have rather than by how close the round came to finishing, and
    // on a branching maze the two disagree sharply - one real round reads 0.79 of the area and 0.99 of
    // the route. They agree only on a corridor maze, where every cell is on the route anyway.
    {
      field: "Route coverage",
      value: (() => {
        const route = routeCells(levelModel)
        if (!route) return "not recorded"

        // From the route and the cells walked rather than from the outlook, which declines a round with no
        // turns. A round that has a route and walked none of it covered none of it, and 0 of 70 is the
        // measurement - where "not recorded" belongs to the round whose route was never computed.
        const walked = new Set(levelModel.turns.flatMap((turn) => turn.cells))
        const covered = route.filter((cell) => walked.has(cell)).length
        return `${formatCount(covered)} of ${formatCount(route.length)} route cells (${Math.round((covered / route.length) * 100)}%)`
      })(),
    },
    // What the round spent, in the one unit that measures a maze: a round opens with a decay unit per cell
    // and spends at least one a turn, so slack, batching and error debt are the whole of what it cost.
    //
    // Headroom is the three added up, not a fourth measurement: it is what the round had left over after the
    // route it walked and the mistakes it paid for, and a reader can check it against the terms beside it.
    {
      field: "Decay ledger",
      value: (() => {
        if (!ledger) return "not recorded"

        return (
          `${term(ledger.routeSlack)} slack \u00b7 ${term(ledger.batchCredit)} batched \u00b7 ` +
          `${term(ledger.errorDebt)} error debt \u2192 headroom ${term(ledger.headroom)}`
        )
      })(),
    },
    {
      field: "Batch depth",
      value: (() => {
        if (!ledger) return "not recorded"

        return batchDepthOf(ledger, roundPlayed(levelModel))
      })(),
    },
    // The turns that entered no new cell, split by what the log graded the cells they re-entered. Both cost
    // one unit, so the budget cannot tell them apart - and one is what the prompt asks for at a confirmed
    // dead end while the other is a rubric violation.
    {
      field: "No progress",
      value: (() => {
        if (!outlook) return "not recorded"

        return [
          `${formatCount(outlook.retreats)} retreating`,
          `${formatCount(outlook.oscillations)} oscillating`,
          outlook.unclassified > 0 ? `${formatCount(outlook.unclassified)} ungraded` : "",
          outlook.wallContacts > 0 ? `${formatCount(outlook.wallContacts)} refused a move` : "",
        ]
          .filter((part) => part !== "")
          .join(" \u00b7 ")
      })(),
    },
    // The paces, worded so none of them can be read as the verdict: each says the round was behind where it
    // would have to be, which is a thing a round can still recover from.
    {
      field: "Pace warnings",
      value: (() => {
        // "none" is a finding, and it needs a budget to have been read: every pace compares a distance
        // against the units left, so with nothing to compare them to the answer is that nothing was read.
        if (!outlook || outlook.budgetTurns === 0) return "not recorded"

        const warnings = [
          outlook.beyondDecayLeftFrom === null
            ? ""
            : `the target was further than the budget from turn ${formatCount(outlook.beyondDecayLeftFrom)}`,
          outlook.beyondOwnPaceFrom === null
            ? ""
            : `further than its own batching could reach from turn ${formatCount(outlook.beyondOwnPaceFrom)}`,
          outlook.behindObservedPaceFrom === null
            ? ""
            : `new ground needed faster than any run has sustained, from turn ${formatCount(outlook.behindObservedPaceFrom)}`,
        ].filter((one) => one !== "")

        return warnings.length === 0 ? "none" : warnings.join(" \u00b7 ")
      })(),
    },
  ];
}

/** mazeLevelRows describes the level as a whole rather than any one agent: how the round ended and what it
 * cost, then the maze it was played on and the two proofs that it was a valid perfect maze.
 *
 * One list rather than a structure half and a round half, because the reader's order is neither: the
 * outcome is what a report is opened for, the success path is only meaningful beside the maze size it is a
 * fraction of, and the proofs are the last thing anyone reads. Split across two functions, the rows could
 * only be ordered within their half, and the two facts that belong side by side sat in different tables. */
export function mazeLevelRows(levelModel: ReplayModel | null | undefined): SummaryRow[] {
  if (!levelModel?.stats) return [];

  const stats = levelModel.stats;
  const outcome = levelModel.outcome ?? {};
  const routeLength = stats.successPathCells;

  // The turn count on its own says how many attempts there were and nothing about what they cost. The
  // breakdown says both, and it is the same partition the strip under the scrubber draws - so a reader
  // can add the bottom bars up and land on these numbers. The text here is the fallback; the view
  // renders the same tally with the strip's own colours.
  //
  // Joined with "+" rather than a middot: the parts are a partition of the total, and the sign says so.
  // A separator that only groups leaves the reader to guess whether these are shares of 473 or three
  // unrelated tallies printed beside it.
  const tally = decayTally(levelModel.turns);
  const parts = tally.counts.map((entry) => formatCount(entry.count));
  if (tally.unreported > 0) parts.push(`${formatCount(tally.unreported)} unreported`);

  return [
    // The outcome with the score it ended on, which is the figure the game itself reports a round by. On
    // its own the word says whether the round finished and nothing about how it went: two unfinished
    // rounds, one stopped at 6,700 and one at 0, read identically without it.
    //
    // "final scores", plural, is Tapoo's own label for it and stays plural whatever the round holds.
    {
      field: "Outcome",
      value: (() => {
        const outcomeName = outcome.outcome ?? "unfinished"
        const score = finalScore(levelModel)
        return score === null ? outcomeName : `${outcomeName} (final scores: ${formatCount(score)})`
      })(),
    },
    {
      field: "Turns",
      value:
        parts.length > 1 ? `${formatCount(levelModel.turns.length)} (${parts.join(" + ")})` : formatCount(levelModel.turns.length),
    },
    // Null, not zero, where the round stated no destination: the route was never computed, and "0 of 70
    // (0%)" reads as a measured route of no length.
    {
      field: "Success path",
      value:
        routeLength === null
          ? "not recorded"
          : `${formatCount(routeLength)} of ${formatCount(stats.cells)} (${Math.round((routeLength / stats.cells) * 100)}%)`,
    },
    // How much of its own history the agent could see, which bounds what any verdict about its choices
    // can fairly claim: a move that looks careless at radius 2 may have been the best available to
    // something that could not see the cell it had already exhausted.
    {
      field: "History window",
      value:
        levelModel.historyWindowRadius === null
          ? "not recorded"
          : `${formatCount(levelModel.historyWindowRadius)} cells (Manhattan radius)`,
    },
    // The maze itself, under the round that was played on it. It does not change as the round runs, which is
    // why it sits below the rows that do - and directly under the success path, which is a fraction of the
    // cell count on the first line of it.
    {field: "Maze size", value: `${stats.rows} x ${stats.cols} (${formatCount(stats.cells)} cells)`},
    {field: "Dead ends", value: formatCount(stats.deadEnds)},
    {field: "Edges", value: formatCount(stats.edges)},
    {field: "Corridors", value: formatCount(stats.corridors)},
    {field: "3-exit junctions (deg3)", value: formatCount(stats.deg3)},
    {field: "4-exit junctions (deg4)", value: formatCount(stats.deg4)},
    {field: "Acyclic graph proof", value: `Edges = Maze_size - 1 = ${formatCount(stats.cells - 1)}`},
    {field: "Handshaking lemma proof", value: `Dead ends = deg3 + 2·deg4 + 2 = ${formatCount(stats.deg3 + 2 * stats.deg4 + 2)}`},
  ];
}
