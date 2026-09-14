/** One round, written the way each Tapoo version writes it.
 *
 * The oracle reads logs, and a log is whatever the producer wrote on the day it ran - so a shape is not
 * superseded when the next one lands, it joins the set the reader has to answer for. The snapshot in
 * _snapshot_/ is a single version's bytes, which is evidence for that version and silence about the
 * others: it states a seat and a model on every request, so nothing in it exercises the recovery an older
 * log needs.
 *
 * These build the same round twice - the same maze, the same two turns, the same outcome - and differ only
 * in what the producer of each version stamped on it. What a reader is told about the round has to come
 * out the same either way; what a reader is told about the harness is what the versions differ on, and
 * that is asserted too rather than left to whichever shape happened to be in the fixture.
 */
import {describe, expect, it} from "vitest"

import {LOG_EVENTS} from "./log-events"
import {agentRows, provenanceRows} from "./report-adapters"
import {expectOk, firstRound, must, sliceLogText} from "./test-support"
import {fnv1a64Checksum} from "./utils"
import type {AgentSummary, SummaryRow} from "./types"

const MAZE = {
  index_chars: ["|", "---", "-", "   ", " ", "\n"],
  structure_checksum: "0x74af82cb14470b9d",
  structure:
    "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
  dimensions: {numCols: 6, numRows: 4, area: 24},
}

const PERSONA = "You are the agent for this level, and you start it primed for success: your traversal speed has not been measured yet."
const TOOLS = [{name: "get_maze_structure", description: "Get current/destination cells and the nearby explored maze structure in one call."}]
  .map((tool) => ({...tool, description_checksum: fnv1a64Checksum(tool.description)}))

/** Every field a version added, and nothing about the round itself.
 *
 * v2.5.1 states who is playing in one place only: the decorated label, which carries the name and the
 * speed and nothing else. v2.6.1 states the seat, the name and the full model on the request, and adds the
 * harness settings beside them - so the same round says more about the run without saying anything
 * different about the play. */
const SHAPES = {
  "2.5.1": {
    envelope: {},
    request: {player: "Katara the Navigator - 1.0000x"},
    outcomeAgent: {playerName: "Katara"},
  },
  "2.6.1": {
    envelope: {platform: "http://0.0.0.0:5500/agents", device: "Chrome/152.0.0.0 on macOS"},
    request: {
      player: "Katara the Navigator - 1.0000x",
      playerName: "Katara",
      seatId: 1,
      model: "gemma4:cloud",
      echoBackReasoning: false,
      requestIntervalSeconds: 5,
    },
    outcomeAgent: {seatId: 1, playerName: "Katara", model: "gemma4:cloud"},
  },
} as const

type Version = keyof typeof SHAPES

const logOf = (version: Version): string => {
  const shape = SHAPES[version]
  let clock = 1788100000000
  const entry = (payload: string, details: unknown, turn: number) => ({
    epochMs: (clock += 1200), time: "2026-09-13 10:00:00", turn, level: 1, game: 2, log: "info", payload, details,
  })
  const turnOf = (turn: number, cell: {row: number; col: number}, open: string) => [
    entry(LOG_EVENTS.request, {
      ...shape.request,
      api: "ollama",
      endpoint: "http://localhost:11434/api/chat",
      reasoning: "max",
      tools: TOOLS,
      messages: [
        {role: "system", content: PERSONA, content_checksum: fnv1a64Checksum(PERSONA)},
        {role: "tool", content: JSON.stringify({
          level: 1, currentCell: cell, destinationCell: {row: 0, col: 5}, historyWindowRadius: 2,
          filteredTraversalHistory: [
            {playerName: "Katara", cell, cellType: "corridor", openMoves: {[open]: {visitStatus: "unvisited"}}},
          ],
        })},
      ],
    }, turn),
    // The echo every provider answers with: the declared name without its ":provider" suffix, and the only
    // model a v2.5.1 log states anywhere.
    entry(LOG_EVENTS.response, {payload: {model: "gemma4", message: {content: '{"moves":["MoveDown"]}'}}}, turn),
  ]

  return JSON.stringify({
    name: "tapoo",
    version,
    mode: "agent-api",
    downloadedAt: "2026-09-13T13-50-30+02-00",
    ...shape.envelope,
    entries: [
      entry(LOG_EVENTS.levelStarted, {
        startPosition: {x: 1, y: 1}, destinationCell: {row: 0, col: 5}, historyWindowRadius: 2, maze: MAZE,
      }, 0),
      ...turnOf(0, {row: 0, col: 0}, "MoveDown"),
      ...turnOf(1, {row: 1, col: 0}, "MoveDown"),
      entry(LOG_EVENTS.levelWon, {
        outcome: "won",
        traversalSpeed: "1.0000",
        agent: shape.outcomeAgent,
        turnCount: 2,
        playerPosition: {x: 1, y: 5},
        playerUniqueCellsVisited: 2,
        decayUnitsCharged: 2,
      }, 2),
    ],
  })
}

const reportOf = (version: Version) => firstRound(sliceLogText(logOf(version), {label: version}))
const seatOf = (version: Version): AgentSummary => must(reportOf(version).agents[0], `${version}'s only seat`)
const value = (rows: SummaryRow[], field: string) => rows.find((row) => row.field === field)?.value

const VERSIONS = Object.keys(SHAPES) as Version[]

describe("a round read out of every Tapoo shape", () => {
  // The play is the log's, not the producer's: the same two turns through the same maze, ending the same
  // way. A version that changed any of this would be a version the oracle reports differently, which is
  // the one thing it must not do.
  it.each(VERSIONS)("answers the same round from a v%s log", (version) => {
    const report = reportOf(version)
    const played = must(report.playedRound, "the round")
    const seat = seatOf(version)

    expect(played.turns).toHaveLength(2)
    expect(played.identity).toEqual({game: 2, level: 1})
    expect(seat.name).toBe("Katara")
    expect(seat.traversalSpeed).toBe(1)
    expect(seat.uniqueCells).toBe(2)
    expect(seat.decayCharged).toBe(2)
    expect(seat.apis).toEqual(["ollama"])
    expect(seat.endpoints).toEqual(["http://localhost:11434/api/chat"])
    expect(seat.reasoningEfforts).toEqual(["max"])
  })

  // Where they differ, and why each difference is what it is.
  //
  // The seat: v2.6.1 states it, v2.5.1 states nothing to state it with, so the record holds null and the
  // Agents table falls back to first-acting order - "Seat 1" either way, but only one of them is the log's
  // own answer.
  it("takes the seat from a v2.6.1 request and leaves it unstated on v2.5.1", () => {
    expect(seatOf("2.6.1").seatId).toBe(1)
    expect(seatOf("2.5.1").seatId).toBeNull()
  })

  // The model: declared on the request from v2.6.1, and before that only echoed back by the provider with
  // the ":provider" suffix trimmed off. Both name the model; one of them names the build.
  it("reads the declared model on v2.6.1 and the provider's echo on v2.5.1", () => {
    expect(seatOf("2.6.1").models).toEqual(["gemma4:cloud"])
    expect(seatOf("2.5.1").models).toEqual(["gemma4"])
  })

  // The harness settings: stated from v2.6.1, and an empty list before it. Empty is why they are lists of
  // words rather than a boolean and a number - "disabled" and "never stated" are different answers, and a
  // v2.5.1 log gives the second.
  it("states the harness settings on v2.6.1 and nothing on v2.5.1", () => {
    expect(seatOf("2.6.1").echoBackReasoning).toEqual(["disabled"])
    expect(seatOf("2.6.1").requestIntervalSeconds).toEqual(["5"])
    expect(seatOf("2.5.1").echoBackReasoning).toEqual([])
    expect(seatOf("2.5.1").requestIntervalSeconds).toEqual([])
  })

  // And what a reader sees of that: the same sentence, with the clauses a v2.5.1 log cannot fill left out
  // rather than rendered empty or guessed at.
  it("writes each version's settings into the Agents cell", () => {
    expect(agentRows(reportOf("2.6.1").agents)[0]?.value).toBe(
      "gemma4:cloud on the Ollama API at max reasoning effort (echo back reasoning: disabled) " +
      "http://localhost:11434/api/chat (polling rate: 5 sec)",
    )
    expect(agentRows(reportOf("2.5.1").agents)[0]?.value).toBe(
      "gemma4 on the Ollama API at max reasoning effort http://localhost:11434/api/chat",
    )
  })

  // The envelope: v2.6.1 records where the run happened, and a log written before it says so rather than
  // leaving the rows blank - an empty row reads as a value that failed to load.
  it("shows the runtime a v2.6.1 export names, and not-recorded before it", () => {
    const shown = (version: Version) => provenanceRows(expectOk(sliceLogText(logOf(version), {label: version})).source)

    expect(value(shown("2.6.1"), "Platform")).toBe("http://0.0.0.0:5500/agents")
    expect(value(shown("2.6.1"), "Device")).toBe("Chrome/152.0.0.0 on macOS")
    expect(value(shown("2.5.1"), "Platform")).toBe("not recorded")
    expect(value(shown("2.5.1"), "Device")).toBe("not recorded")
  })
})
