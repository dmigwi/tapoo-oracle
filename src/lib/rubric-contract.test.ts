/** The rubric's own contract: what a round has to be true of itself for its evidence to mean anything.
 *
 * Beside rubric-contract.ts rather than in log-contract.test.ts, for the reason the module is its own: a
 * checksum failing is a damaged log, where a finding here is an intact log describing a run that cannot be
 * compared. The fixtures say the same - nothing here needs a byte of a real export, only the summaries a
 * round was parsed into.
 */
import {describe, expect, it} from "vitest"

import fixtureData from "./_snapshot_/tapoo-v2.6.1-agent-api-logs-1789240357.json" with {type: "json"}
import {agentSettingsCheck, roundTotalsCheck, seatRosterCheck} from "./rubric-contract"
import {roundReportFor} from "./rubric-report"
import {at, expectOk, must, sliceLogText, twoSeatDriftLog} from "./test-support"
import type {AgentSummary, CellKey, Move, Outcome, TurnSummary} from "./types"

// End to end over a whole log, because every other test of this reaches agentsFromRound directly. The real
// capture seats one agent per round and neither changed anything, so it cannot show what a round that is
// not one experiment looks like - see twoSeatDriftLog for why it is built rather than saved.
describe("a log whose seat changed model mid-round", () => {
  const round = () => {
    const result = expectOk(sliceLogText(JSON.stringify(twoSeatDriftLog()), {label: "two-seat"}))
    const opened = roundReportFor(must(result.rounds[0], "a round"))
    return {report: opened.report, checks: opened.round.checks}
  }

  it("reads both seats, each with the setup its own turns stated", () => {
    const agents = round().report.agents

    expect(agents.map((agent) => [agent.seatId, agent.name, agent.models, agent.apis])).toEqual([
      [1, "Katara", ["moonshotai/Kimi-K3:baseten", "moonshotai/Kimi-K3:together"], ["openai"]],
      [2, "Bumi", ["gemma4:cloud"], ["ollama"]],
    ])
  })

  it("reports the change, naming the seat, the setting and both models", () => {
    const check = must(round().checks.find((entry) => entry.name === "Agent settings"), "the settings check")

    expect(check.outcome).toBe("failed")
    expect(check.detail).toBe(
      "Katara ran 2 models (moonshotai/Kimi-K3:baseten, moonshotai/Kimi-K3:together) - " +
      "this makes it hard to replicate this report output/profile.",
    )
  })

  // The drift has to be the only finding, or the fixture is demonstrating its own defects. Its prompts
  // and tool descriptions carry checksums computed with the app's own hash, so they verify.
  it("is otherwise a clean round, so the finding is the one thing to read", () => {
    expect(round().checks.map((check) => [check.name, check.outcome])).toEqual([
      ["Encoded maze", "passed"],
      ["Prompts and tool descriptions", "passed"],
      // No repeats and no traversal checksums: honestly unverifiable rather than quietly passed.
      ["Trimmed checksummed repeats", "unchecked"],
      ["Tool descriptions", "passed"],
      ["Agent personas", "passed"],
      // No warning was issued, which is the good case and reads as one.
      ["User warnings", "passed"],
      ["Traversal payloads", "unchecked"],
      ["Seat roster", "passed"],
      ["Agent settings", "failed"],
      // The fixture's outcome states no totals of its own, so there is nothing to compare its turns with.
      ["Round totals", "unchecked"],
    ])
  })
})

// Two readings of one round: what the outcome states about it, and what walking its turns settled. The
// report is worth more for saying whether they agree than for quietly preferring one of them.
describe("roundTotalsCheck", () => {
  const turn = (n: number, cells: CellKey[], applied: number, decay: number | null): TurnSummary => ({
    turn: n, seatId: null, playerName: "Kora", before: cells[0] ?? null, moves: ["MoveDown"] as Move[],
    submittedCount: 1, applied, cells, rejectedMove: null, traversalSpeed: null,
    decayCharged: decay,
  })
  const walked = [turn(0, ["0,0", "1,0"], 1, 1), turn(1, ["1,0", "2,0"], 1, 1)]
  const totals = (over: Partial<Outcome> = {}): Outcome => ({
    outcome: "won", agent: {playerName: "Kora"},
    turnCount: 2, playerUniqueCellsVisited: 2, decayUnitsCharged: 2, traversalSpeed: "1.0000", ...over,
  })

  it("says so where the two readings are the same", () => {
    expect(roundTotalsCheck(walked, totals())).toMatchObject({
      name: "Round totals",
      scope: "round",
      outcome: "passed",
      detail: "2 cells and 2 units charged, the same the turns settled",
    })
  })

  // The ordinary gap, and not a fault: Tapoo reports a turn's charge on the turn after it, so a round's
  // last charge is usually unreported and the stated figure is the completer one.
  it("passes where the round states more than its turns had yet reported", () => {
    const unreported = [walked[0]!, {...walked[1]!, decayCharged: null}]

    expect(roundTotalsCheck(unreported, totals({decayUnitsCharged: 3}))).toMatchObject({
      outcome: "passed",
      detail: "2 cells and 3 units charged, against 2 and 1 the turns settled - the round states what its last turns had not yet reported",
    })
  })

  // The fault: a total the turns cannot bear. A seat cannot enter more new cells than it applied moves, so
  // this is the log disagreeing with itself - and the seat keeps its own account rather than reporting a
  // route efficiency above 1, which is what the detail says it did.
  it("fails where the round states more cells than its turns could have entered", () => {
    expect(roundTotalsCheck(walked, totals({playerUniqueCellsVisited: 5}))).toMatchObject({
      outcome: "failed",
      detail:
        "the round states 5 cells entered on 2 applied moves, which its own turns cannot account for, " +
        "so each seat reports what its turns settled instead",
    })
  })

  // The other way it cannot bear them: Tapoo charges at least one unit per turn, so more turns than units
  // is not a round that played cheaply.
  it("fails where the round states fewer charges than turns", () => {
    expect(roundTotalsCheck(walked, totals({turnCount: 5, decayUnitsCharged: 2}))).toMatchObject({
      outcome: "failed",
      detail:
        "the round states 5 turns charged 2 units, which its own turns cannot account for, so each seat " +
        "reports what its turns settled instead",
    })
  })

  it("checks nothing where the round states no totals", () => {
    expect(roundTotalsCheck(walked, null)).toMatchObject({
      outcome: "unchecked",
      detail: "the round states no totals of its own to compare",
    })
    expect(roundTotalsCheck(walked, totals({playerUniqueCellsVisited: undefined})).outcome).toBe("unchecked")
  })

  // On the round the snapshot finished: the two readings agree exactly, which is the answer this check
  // exists to be able to give.
  it("reports the snapshot's finished round as agreeing", () => {
    const sliced = expectOk(sliceLogText(JSON.stringify(fixtureData), {label: "snapshot"}))
    const {round} = roundReportFor(at(sliced.rounds, 0))

    expect(must(round.checks.find((check) => check.name === "Round totals"), "the totals check")).toMatchObject({
      outcome: "passed",
      detail: "69 cells and 67 units charged, the same the turns settled",
    })
  })
})

// A seat is one player and a player is one seat. Both directions fail silently without a check, and they
// fail differently - which is why the check reads the turns rather than the records they produce.
describe("seatRosterCheck", () => {
  const played = (turn: number, seatId: number | null, playerName: string | null) => ({
    turn, seatId, playerName, before: "0,0", moves: ["MoveDown"] as Move[], submittedCount: 1, applied: 1,
    cells: ["0,0", "1,0"], rejectedMove: null, traversalSpeed: null, decayCharged: null,
  })

  it("passes a round where each seat kept one player", () => {
    const check = seatRosterCheck([played(0, 1, "Katara"), played(1, 2, "Bumi"), played(2, 1, "Katara")])

    expect(check.outcome).toBe("passed")
    expect(check.detail).toBe("2 seats, one player each, throughout")
    expect(seatRosterCheck([played(0, 1, "Katara")]).detail).toBe("one seat, one player, throughout")
  })

  // The destructive direction. The second turn matches the seat, so the record is found and its name kept,
  // and Bumi's turn is credited to Katara - one row on the page holding two agents' cells and charge, with
  // nothing about it out of place. Nothing downstream can find this, which is why it is caught here.
  it("reports one seat played under two players", () => {
    const check = seatRosterCheck([played(0, 1, "Katara"), played(1, 1, "Bumi")])

    expect(check.outcome).toBe("failed")
    expect(check.detail).toBe(
      "seat 1 played as 2 players (Katara, Bumi) - a seat is one player and a player is one seat, so " +
      "these turns cannot be told apart",
    )
  })

  // The visible direction: two records with one name, so the page shows the player twice and anything
  // reading a seat by name reaches whichever comes first.
  it("reports one player playing from two seats", () => {
    const check = seatRosterCheck([played(0, 1, "Katara"), played(1, 2, "Katara")])

    expect(check.outcome).toBe("failed")
    expect(check.detail).toMatch(/^Katara played from 2 seats \(1, 2\)/)
  })

  // A turn stating one of the two says nothing: a log that numbers no turn is the ordinary case, and this
  // check has no opinion on it.
  it("says nothing where no turn stated both a seat and a player", () => {
    const check = seatRosterCheck([played(0, null, "Katara"), played(1, 2, null)])

    expect(check.outcome).toBe("unchecked")
    expect(check.detail).toBe("no turn stated both a seat and a player")
  })
})

describe("agentSettingsCheck", () => {
  const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
    name: "Katara", seatId: null, models: ["gemma4"], apis: ["ollama"], endpoints: [], 
    reasoningEfforts: ["max"], echoBackReasoning: [], requestIntervalSeconds: [],
    cellsEntered: null, uniqueCells: null, decayCharged: null, traversalSpeed: null, settled: null, ...over,
  })

  it("passes a round whose seats each held one setup throughout", () => {
    const check = agentSettingsCheck([agent(), agent({name: "Bumi"})])

    expect(check.outcome).toBe("passed")
    expect(check.detail).toBe("2 seats, each on one model, endpoint and reasoning effort throughout")
    expect(agentSettingsCheck([agent()]).detail).toBe("one seat, on one model, endpoint and reasoning effort throughout")
  })

  // Which setting, and between which values. A bare count told a reader that something moved and left
  // them to find what in the Agents table.
  it("names the setting a seat changed and the values it changed between", () => {
    const check = agentSettingsCheck([agent({models: ["gemma4", "glm-5.1"]})])

    expect(check.outcome).toBe("failed")
    expect(check.detail).toBe(
      "Katara ran 2 models (gemma4, glm-5.1) - this makes it hard to replicate this report output/profile.",
    )
  })

  // Every unstable seat, not just the first. A round with two of them is not one bad seat, and the
  // question this check answers - are these turns comparable - is about the round.
  it("names every seat that drifted, and every setting each one changed", () => {
    const check = agentSettingsCheck([
      agent({models: ["gemma4", "glm-5.1"], reasoningEfforts: ["max", "high"]}),
      agent({name: "Bumi", apis: ["ollama", "openai"]}),
    ])

    expect(check.detail).toBe(
      "Katara ran 2 models (gemma4, glm-5.1) and 2 reasoning efforts (max, high); " +
      "Bumi ran 2 APIs (ollama, openai) - this makes it hard to replicate this report output/profile.",
    )
  })

  // An endpoint may carry user:pass@host, and this detail is rendered into a table cell. The count says
  // the drift happened; the Agents table shows the addresses, stripped on the way in.
  it("counts changed endpoints without printing them", () => {
    const check = agentSettingsCheck([
      agent({endpoints: ["http://user:pass@host/api", "http://other/api"]}),
    ])

    expect(check.outcome).toBe("failed")
    expect(check.detail).toBe("Katara ran 2 endpoints - this makes it hard to replicate this report output/profile.")
    expect(check.detail).not.toMatch(/user:pass|http/)
  })

  // A seat that stated a number and no player is still named, or a finding would open with " ran 2".
  it("names a drifted seat that stated no player", () => {
    const check = agentSettingsCheck([agent({name: "", seatId: 4, models: ["gemma4", "glm-5.1"]})])

    expect(check.detail).toMatch(/^Seat 4 ran 2 models/)
  })

  it("says nothing of a round that recorded no settings at all", () => {
    const check = agentSettingsCheck([agent({models: [], apis: [], reasoningEfforts: []})])

    expect(check.outcome).toBe("unchecked")
  })
})
