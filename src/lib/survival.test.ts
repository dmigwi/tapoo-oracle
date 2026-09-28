import {describe, expect, it} from "vitest"

import {
  FASTEST_SUSTAINED_PACE,
  NEW_CELLS_PER_TURN_CAP,
  decayLedger,
  survivalFlags,
} from "./survival"

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
