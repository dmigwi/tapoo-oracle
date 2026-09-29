import {describe, expect, it} from "vitest"

import {
  FASTEST_SUSTAINED_PACE,
  NEW_CELLS_PER_TURN_CAP,
  decayLedger,
  survivalFlags,
  survivalSeries,
} from "./survival"
import type {SurvivalInputTurn} from "./survival"
import {must} from "./test-support"

// The capture's won round, which is the one set of figures every part of this is pinned against: a
// 70-cell maze, 67 turns, 67 units charged, 69 moves landed.
const CAPTURE = {cells: 70, decayCharged: 67, played: {turnsTaken: 67, movesApplied: 69, movesUnreported: 0}}

describe("decayLedger", () => {
  it("splits the capture's round into the terms that caused it", () => {
    const ledger = decayLedger(CAPTURE)

    // Every turn cost exactly one unit, so the run paid nothing for errors.
    expect(ledger?.errorDebt).toBe(0)
    expect(ledger?.batchDepth).toBeCloseTo(69 / 67, 12)
    // One cell of the maze it never had to pay for, two moves earned back by batching.
    expect(ledger?.routeSlack).toBe(1)
    expect(ledger?.batchCredit).toBe(2)
    expect(ledger?.headroom).toBe(3)
    expect(ledger?.neededDepth).toBeCloseTo(69 / 70, 12)
  })

  // The identity the report rests on: the three terms are the headroom, so a card may print them and
  // let a reader add them up. Asserted across a table rather than on one round, because a single set of
  // figures can satisfy an accidental arrangement of the same numbers.
  it.each([
    ["the capture", CAPTURE],
    ["a run that paid for errors", {cells: 600, decayCharged: 492, played: {turnsTaken: 483, movesApplied: 602, movesUnreported: 0}}],
    ["a run that never batched", {cells: 24, decayCharged: 20, played: {turnsTaken: 18, movesApplied: 18, movesUnreported: 0}}],
    ["a run on a branching maze, where slack goes negative", {cells: 70, decayCharged: 70, played: {turnsTaken: 41, movesApplied: 96, movesUnreported: 0}}],
  ])("reconciles the terms with the headroom for %s", (_what, counts) => {
    const ledger = decayLedger(counts)

    expect(ledger).not.toBeNull()
    const {routeSlack, batchCredit, errorDebt, headroom, batchDepth} = ledger!
    expect(routeSlack + batchCredit - errorDebt).toBe(headroom)
    // And the formula the terms stand in for: A - moves/b - p, at the depth the run achieved.
    expect(counts.cells - counts.played.movesApplied / batchDepth - errorDebt).toBeCloseTo(headroom, 9)
  })

  // What the needed depth is for: the run's own b against the b the maze still demanded.
  it("states the depth the maze demanded beside the depth the run reached", () => {
    const short = decayLedger({cells: 600, decayCharged: 624, played: {turnsTaken: 470, movesApplied: 620, movesUnreported: 0}})

    expect(short?.errorDebt).toBe(154)
    // 620 moves over the 446 units its errors left it - a depth well past what it managed.
    expect(short?.neededDepth).toBeCloseTo(620 / 446, 12)
    expect(short!.neededDepth).toBeGreaterThan(short!.batchDepth)
  })

  // Null, not a record of zeros: a seat with nothing measured has no account, and a zeroed ledger reads
  // as a run that spent nothing.
  it.each([
    ["no turns at all", {cells: 70, decayCharged: 3, played: null}],
    ["no turn that moved", {cells: 70, decayCharged: 3, played: {turnsTaken: 3, movesApplied: 0, movesUnreported: 3}}],
    ["no charge reported", {cells: 70, decayCharged: null, played: {turnsTaken: 3, movesApplied: 3, movesUnreported: 0}}],
  ])("draws no ledger where the round did not say: %s", (_what, counts) => {
    expect(decayLedger(counts)).toBeNull()
  })

  // A charge below one per turn is the log disagreeing with itself - Tapoo charges every turn - and a
  // negative debt would print as a credit the run never earned. roundTotalsCheck is where that is
  // reported; here it is simply not an account.
  it("draws no ledger where the charge is below one per turn", () => {
    expect(decayLedger({cells: 70, decayCharged: 2, played: {turnsTaken: 3, movesApplied: 3, movesUnreported: 0}})).toBeNull()
  })

  // And none where the errors already cost more than the maze holds: there is no depth that covers a
  // budget of nothing, and the division would answer with a sign rather than a depth.
  it("draws no ledger where the debt exceeds the maze", () => {
    expect(decayLedger({cells: 24, decayCharged: 60, played: {turnsTaken: 30, movesApplied: 30, movesUnreported: 0}})).toBeNull()
  })
})

describe("survivalFlags", () => {
  const flagsFor = (unvisitedRoute: number, decayLeft: number | null, over: {distanceToTarget?: number | null; batchDepth?: number | null} = {}) =>
    survivalFlags({unvisitedRoute, decayLeft, distanceToTarget: null, batchDepth: null, ...over})

  // The boundary is where the rule is: at exactly four cells per unit the run can still finish, and one
  // cell more is what it cannot.
  it("is lost one cell past four per unit, and not at four", () => {
    expect(flagsFor(NEW_CELLS_PER_TURN_CAP * 10, 10).lost).toBe(false)
    expect(flagsFor(NEW_CELLS_PER_TURN_CAP * 10 + 1, 10).lost).toBe(true)
  })

  it("warns one cell past the fastest pace observed, and not at it", () => {
    expect(flagsFor(Math.floor(FASTEST_SUSTAINED_PACE * 10), 10).behindObservedPace).toBe(false)
    expect(flagsFor(Math.ceil(FASTEST_SUSTAINED_PACE * 10) + 1, 10).behindObservedPace).toBe(true)
  })

  // The distinction the whole rule rests on. A retreat leaves the seat further from the target for one
  // unit spent, so a verdict reading distance would fire and then switch off again as the seat walks
  // back out; the route cells it has not entered cannot fall when it retraces ground it already covered.
  it("never lets distance decide whether a run is lost", () => {
    const stranded = flagsFor(1, 10, {distanceToTarget: 500, batchDepth: 1})

    expect(stranded.lost).toBe(false)
    expect(stranded.behindObservedPace).toBe(false)
    // It is still worth saying, as the warnings it is.
    expect(stranded.beyondDecayLeft).toBe(true)
    expect(stranded.beyondOwnPace).toBe(true)
  })

  it("reads distance against the budget and against the run's own depth", () => {
    expect(flagsFor(1, 10, {distanceToTarget: 10}).beyondDecayLeft).toBe(false)
    expect(flagsFor(1, 10, {distanceToTarget: 11}).beyondDecayLeft).toBe(true)
    // A run batching two moves a turn reaches twice as far on the same budget.
    expect(flagsFor(1, 10, {distanceToTarget: 20, batchDepth: 2}).beyondOwnPace).toBe(false)
    expect(flagsFor(1, 10, {distanceToTarget: 21, batchDepth: 2}).beyondOwnPace).toBe(true)
  })

  // An unmeasured budget is not a finding. The capture has a turn like this - the one that won, which no
  // later request exists to report - and a run is not lost because its last turn went unreported.
  it("finds nothing where the budget was never reported", () => {
    expect(flagsFor(500, null, {distanceToTarget: 500, batchDepth: 1})).toEqual({
      lost: false,
      behindObservedPace: false,
      beyondDecayLeft: false,
      beyondOwnPace: false,
    })
  })

  // The property the verdict is stated as: once true it cannot become false, whatever the run does next.
  // Four cells a turn is the most any turn has entered, and every turn costs at least one unit, so the
  // worst case for the rule is a run discovering at full speed on the cheapest possible turns.
  it("stays lost once lost, at the fastest discovery any turn has managed", () => {
    let unvisitedRoute = 4 * 12 + 1
    let decayLeft = 12
    expect(survivalFlags({unvisitedRoute, decayLeft, distanceToTarget: null, batchDepth: null}).lost).toBe(true)

    while (decayLeft > 0) {
      unvisitedRoute = Math.max(0, unvisitedRoute - NEW_CELLS_PER_TURN_CAP)
      decayLeft -= 1
      expect(survivalFlags({unvisitedRoute, decayLeft, distanceToTarget: null, batchDepth: null}).lost).toBe(true)
    }
  })
})

describe("survivalSeries", () => {
  // A corridor of six cells, the seat starting at one end and the destination at the other.
  const ROUTE = ["0,0", "0,1", "0,2", "0,3", "0,4", "0,5"]
  const DISTANCES = new Map(ROUTE.map((cell, index) => [cell, ROUTE.length - 1 - index]))
  const turn = (over: Partial<SurvivalInputTurn> & {turn: number}): SurvivalInputTurn =>
    ({cells: [], applied: 1, applicable: 1, decayRemaining: null, ...over})

  const seriesOf = (
    turns: SurvivalInputTurn[],
    over: {statuses?: Map<number, Map<string, string>>; batchDepth?: number | null} = {},
  ) =>
    survivalSeries({
      turns,
      route: ROUTE,
      distances: DISTANCES,
      statusesAt: (at) => over.statuses?.get(at),
      batchDepth: over.batchDepth ?? null,
    })

  it("counts down the route cells the seat has still to enter", () => {
    const outlook = must(seriesOf([
      turn({turn: 0, cells: ["0,0", "0,1"]}),
      turn({turn: 1, cells: ["0,1", "0,2"]}),
    ]), "an outlook")

    expect(outlook.routeCells).toBe(6)
    // The cell it started on counts as entered: it is standing there.
    expect(outlook.series.map((one) => one.unvisitedRoute)).toEqual([4, 3])
    expect(outlook.visitedRouteCells).toBe(3)
  })

  it("measures the distance from the cell each turn left it standing on", () => {
    const outlook = must(seriesOf([turn({turn: 0, cells: ["0,0", "0,1", "0,2"], applied: 2, applicable: 2})]), "an outlook")

    expect(outlook.series[0]?.distanceToTarget).toBe(3)
  })

  // The split the budget cannot make. Both turns below cost one unit and enter no new cell; one is the
  // retreat the prompt asks for at a dead end, the other is the oscillation the rubric counts against a
  // run. A report that pooled them would call these two runs the same.
  //
  // Which is which follows Tapoo's own grading: a cell goes to `oscillating` only after a dead end has been
  // entered again past exhaustion, so a turn into one is a withdrawal back out of finished ground. A turn
  // into cells that still have an exit to spend, gaining nothing by it, is the dithering between live
  // options that the rubric counts.
  it("splits a retreat from an oscillation, on turns charged the same", () => {
    const statuses = new Map([
      [1, new Map([["0,0", "oscillating"]])],
      [2, new Map([["0,1", "backtracking"]])],
    ])
    const outlook = must(seriesOf([
      // Out to a cell it had not entered, then back over its own ground twice - the same one unit each.
      turn({turn: 0, cells: ["0,0", "0,1"], decayRemaining: 6}),
      turn({turn: 1, cells: ["0,1", "0,0"], decayRemaining: 5}),
      turn({turn: 2, cells: ["0,0", "0,1"], decayRemaining: 4}),
    ], {statuses}), "an outlook")

    expect(outlook.series.map((one) => one.progress)).toEqual(["advanced", "retreat", "oscillation"])
    expect(outlook.retreats).toBe(1)
    expect(outlook.oscillations).toBe(1)
  })

  it("grades a turn that entered a cell it had not as advanced, whatever the cells read", () => {
    const statuses = new Map([[0, new Map([["0,1", "oscillating"]])]])
    const outlook = must(seriesOf([turn({turn: 0, cells: ["0,0", "0,1"]})], {statuses}), "an outlook")

    expect(outlook.series[0]?.progress).toBe("advanced")
  })

  it("says a turn moved nowhere rather than grading ground it never entered", () => {
    const outlook = must(seriesOf([turn({turn: 0, cells: [], applied: 0})]), "an outlook")

    expect(outlook.series[0]?.progress).toBe("still")
  })

  // A grade this module invented would be a grade nothing could check, so an ungraded cell is named as
  // what it is. The capture has turns like this: a round records no traversal history for a turn that
  // failed before the tools answered.
  it("leaves a no-progress turn unclassified where the log graded nothing", () => {
    const outlook = must(seriesOf([
      turn({turn: 0, cells: ["0,0", "0,1"]}),
      turn({turn: 1, cells: ["0,1", "0,0"]}),
    ]), "an outlook")

    expect(outlook.series.map((one) => one.progress)).toEqual(["advanced", "unclassified"])
    expect(outlook.unclassified).toBe(1)
    expect(outlook.retreats).toBe(0)
  })

  // Wall contact is a move the maze refused, not a command it could not read. The second is the model
  // spelling a move wrong, which the rubric already reports against the prediction.
  it("reads a refused move off what the turn could have applied", () => {
    const outlook = must(seriesOf([
      turn({turn: 0, cells: ["0,0", "0,1"], applied: 1, applicable: 2}),
      turn({turn: 1, cells: ["0,1", "0,2"], applied: 1, applicable: 1}),
    ]), "an outlook")

    expect(outlook.series.map((one) => one.wallContact)).toEqual([true, false])
    expect(outlook.wallContacts).toBe(1)
  })

  // The verdict, and the turn it held from. Monotone, so the first turn it fired on is the answer rather
  // than "at some point": with one route cell left unentered and no budget, the run cannot finish.
  it("names the first turn from which the run could not finish", () => {
    const outlook = must(seriesOf([
      turn({turn: 0, cells: ["0,0", "0,1"], decayRemaining: 4}),
      turn({turn: 1, cells: ["0,1", "0,0"], decayRemaining: 0}),
      turn({turn: 2, cells: ["0,0", "0,1"], decayRemaining: 0}),
    ]), "an outlook")

    expect(outlook.lostFrom).toBe(1)
    expect(outlook.series.map((one) => one.lost)).toEqual([false, true, true])
  })

  it("has nothing to say about a round that stated no destination", () => {
    expect(survivalSeries({turns: [turn({turn: 0})], route: null, distances: DISTANCES, statusesAt: () => undefined, batchDepth: null})).toBeNull()
    expect(seriesOf([])).toBeNull()
  })
})
