import { describe, expect, it } from "vitest"

import {LOG_EVENTS} from "./log-contract"
import {CAPABILITIES, VIOLATIONS} from "./rubric-report"
import {buildReport} from "./rubric-report"
import {groupOf as group, levelOf as firstLevel, rubricEntry as entry, rubricTurn as turn, toolMessage} from "./test-support";

// The report one round's entries build to: the rubric verdicts, and the facts printed beside them.
// What each question reads out of a log is rubric-context.test.ts.

describe("buildReport", () => {
  it("answers every group defined by the rubric, with fractions preserved", () => {
    const report = buildReport(turn(0, {content: '{"moves":["MoveUp"]}'}))

    expect(report.capabilities).toHaveLength(CAPABILITIES.length)
    expect(report.violations).toHaveLength(VIOLATIONS.length)
    // "2/3" and "0/3" are both a NO, and the contract keeps the difference visible rather than
    // collapsing both into the verdict.
    for (const entry of [...report.capabilities, ...report.violations]) {
      expect(entry.passed).toBeLessThanOrEqual(entry.total)
      expect(Object.keys(entry.answers)).toEqual(Object.keys(entry.questions))
    }
  })

  it("answers NO across the board for a log holding no evidence", () => {
    const report = buildReport([entry(LOG_EVENTS.levelStarted, {level: 1})])

    // NO means the behavior was not observed in this sample. An empty log observes nothing, so no
    // capability may be claimed from it - and no violation may be charged either.
    expect(report.capabilities.every((entry) => entry.met === false)).toBe(true)
    expect(report.violations.every((entry) => entry.met === false)).toBe(true)
  })

  describe("C1 instruction adherence", () => {
    it("holds when the prediction is bare JSON with only a moves key", () => {
      const report = buildReport(turn(0, {content: '{"moves":["MoveUp","MoveDown"]}'}))
      expect(group(report, "C1").met).toBe(true)
    })

    it("fails when the prediction arrives wrapped in a Markdown fence", () => {
      const report = buildReport(turn(0, {content: '```json\n{"moves":["MoveUp"]}\n```'}))
      expect(group(report, "C1").answers.Q1).toBe(false)
      expect(group(report, "C1").met).toBe(false)
    })

    it("fails when the prediction carries a key beyond moves", () => {
      const report = buildReport(turn(0, {content: '{"moves":["MoveUp"],"why":"corridor"}'}))
      expect(group(report, "C1").answers.Q2).toBe(false)
    })

    it("fails when a submitted command is not one of the four moves", () => {
      const report = buildReport(turn(0, {content: '{"moves":["MoveSideways"]}'}))
      expect(group(report, "C1").answers.Q3).toBe(false)
    })
  })

  describe("C3 context acquisition", () => {
    it("holds only when every declared tool was read on the prediction turn", () => {
      const report = buildReport(turn(0, {
        content: '{"moves":["MoveUp"]}',
        messages: [
          toolMessage({currentCell: {row: 0, col: 0}, filteredTraversalHistory: []}),
          toolMessage({suggestedMovesPerTurn: {min: 2, max: 4}, playerUniqueCellsVisited: 2, decayUnitsCharged: 1}),
          toolMessage({lastMoveStatus: "applied", lastSubmittedMoves: ["MoveUp"], lastAppliedMoveIndex: 0, chargedMovesCount: 1}),
        ],
      }))

      expect(group(report, "C3").met).toBe(true)
    })

    it("fails the outcome question when that tool was never read", () => {
      const report = buildReport(turn(0, {
        content: '{"moves":["MoveUp"]}',
        messages: [
          toolMessage({currentCell: {row: 0, col: 0}, filteredTraversalHistory: []}),
          toolMessage({suggestedMovesPerTurn: {min: 2, max: 4}, playerUniqueCellsVisited: 2, decayUnitsCharged: 1}),
        ],
      }))

      // Q3 is the third entry of DECLARED_TOOLS, which is the order the rubric fixes for this group -
      // the tool names appear in the question text, never as answer keys.
      expect(group(report, "C3").answers.Q3).toBe(false)
      expect(group(report, "C3").answers.Q1).toBe(true)
      expect(group(report, "C3").met).toBe(false)
    })
  })

  describe("C3 across several turns", () => {
    const everyTool = [
      toolMessage({currentCell: {row: 0, col: 0}, filteredTraversalHistory: []}),
      toolMessage({suggestedMovesPerTurn: {min: 2, max: 4}, playerUniqueCellsVisited: 2, decayUnitsCharged: 1}),
      toolMessage({lastMoveStatus: "applied", lastSubmittedMoves: ["MoveUp"], lastAppliedMoveIndex: 0, chargedMovesCount: 1}),
    ]

    it("fails when a tool was read on one prediction turn but not the next", () => {
      const report = buildReport([
        ...turn(0, {content: '{"moves":["MoveUp"]}', messages: everyTool}),
        ...turn(1, {content: '{"moves":["MoveDown"]}', messages: everyTool.slice(0, 2)}),
      ])

      // The question is "on every prediction turn". A single turn cannot tell every from any, so
      // this is the case that fixes the meaning: reading a tool once then guessing afterwards is
      // not the behavior being claimed.
      expect(group(report, "C3").answers.Q3).toBe(false)
      expect(group(report, "C3").answers.Q1).toBe(true)
    })

    it("holds when every prediction turn read every tool", () => {
      const report = buildReport([
        ...turn(0, {content: '{"moves":["MoveUp"]}', messages: everyTool}),
        ...turn(1, {content: '{"moves":["MoveDown"]}', messages: everyTool}),
      ])

      expect(group(report, "C3").met).toBe(true)
    })
  })

  describe("V1 tool hallucination", () => {
    it("is confirmed by a single logged hallucinated tool call", () => {
      const report = buildReport([
        ...turn(0, {content: '{"moves":["MoveUp"]}'}),
        entry(LOG_EVENTS.hallucinatedTool, {tool: "get_map_hint"}, {log: "warn"}),
      ])

      expect(group(report, "V1").met).toBe(true)
    })

    it("stays unconfirmed when no such call was logged", () => {
      const report = buildReport(turn(0, {content: '{"moves":["MoveUp"]}'}))
      expect(group(report, "V1").met).toBe(false)
    })
  })

  describe("V2 output contract failure", () => {
    it("is confirmed by a response whose content yields no prediction", () => {
      const report = buildReport(turn(0, {content: "I could not decide this turn."}))
      expect(group(report, "V2").answers.Q1).toBe(true)
      expect(group(report, "V2").met).toBe(true)
    })

    it("is confirmed by a response carrying neither content nor tool calls", () => {
      const report = buildReport([
        entry(LOG_EVENTS.request, {tools: [], messages: []}),
        entry(LOG_EVENTS.response, {payload: {model: "test-model"}}),
      ])

      expect(group(report, "V2").answers.Q2).toBe(true)
    })
  })

  describe("operational diagnostics", () => {
    it("counts endpoint failures without charging them as a violation", () => {
      const report = buildReport([
        ...turn(0, {content: '{"moves":["MoveUp"]}'}),
        entry(LOG_EVENTS.providerHttpFailure, {status: 429}, {log: "error"}),
        entry(LOG_EVENTS.requestFailed, {reason: "network"}, {log: "error"}),
      ])

      // Kept as evidence but never scored: a 429 is the provider's infrastructure, not the model's
      // reasoning, and charging it to the model would put someone else's outage in the profile.
      expect(report.diagnostics.endpointFailures).toBe(2)
      expect(report.violations.every((entry) => entry.met === false)).toBe(true)
    })

    // Counted apart from the failures that caused it. A failed request is one turn answered badly and can
    // be retried; being disabled is the agent leaving the round, and that bounds what every figure beside
    // it covers - the verdicts describe a round that stopped before the log's last turn.
    it("counts each time the agent was disabled, apart from the failures behind it", () => {
      const report = buildReport([
        ...turn(0, {content: '{"moves":["MoveUp"]}'}),
        entry(LOG_EVENTS.requestFailed, {reason: "network"}, {log: "error"}),
        entry(LOG_EVENTS.agentDisabled, {reason: "network"}, {log: "error"}),
        entry(LOG_EVENTS.requestFailed, {reason: "network"}, {log: "error"}),
        entry(LOG_EVENTS.agentDisabled, {reason: "network"}, {log: "error"}),
      ])

      expect(report.diagnostics.agentDisablings).toBe(2)
      expect(report.diagnostics.endpointFailures).toBe(2)
      // Never a violation: the network is not the model's reasoning.
      expect(report.violations.every((entry) => entry.met === false)).toBe(true)
    })

    // The two faults nothing measured before: a provider the app never dispatched to, and a tool handler of
    // Tapoo's that threw. Both stop the round and neither is the model's, so they are counted where a reader
    // can see the round was not the experiment it reports - and kept out of endpointFailures, which is
    // somebody else's outage and leaves the run valid evidence.
    it("counts the harness's own failures apart from the endpoint's", () => {
      const report = buildReport([
        ...turn(0, {content: '{"moves":["MoveUp"]}'}),
        entry(LOG_EVENTS.unsupportedProvider, {api: "bedrock"}, {log: "error"}),
        entry(LOG_EVENTS.toolServiceFailure, {toolNames: ["get_maze_structure"]}, {log: "error"}),
        entry(LOG_EVENTS.providerHttpFailure, {status: 503}, {log: "error"}),
      ])

      expect(report.diagnostics.harnessFailures).toBe(2)
      expect(report.diagnostics.endpointFailures).toBe(1)
      // Never a violation: neither is something the model did.
      expect(report.violations.every((entry) => entry.met === false)).toBe(true)
    })

    it("counts a token cap exhaustion as both a diagnostic and resource waste", () => {
      const report = buildReport([
        ...turn(0, {content: '{"moves":["MoveUp"]}'}),
        entry(LOG_EVENTS.tokenCapExhausted, {tokensUsage: 10000}, {log: "warn"}),
      ])

      expect(report.diagnostics.tokenExhaustions).toBe(1)
      expect(group(report, "V5").answers.Q3).toBe(true)
    })
  })

  describe("round outcome", () => {
    it("reports the winning traversal speed and its class", () => {
      const report = buildReport([
        ...turn(0, {content: '{"moves":["MoveUp"]}'}),
        entry(LOG_EVENTS.levelWon, {outcome: "won", traversalSpeed: "1.5000", agent: {playerName: "Kora"}}),
      ])

      expect(report.traversalSpeed).toBe(1.5)
      expect(report.traversalSpeedClass).toBe("Trailblazer")
      // Named on the seat that finished, not on the report: a round can seat more than one.
      expect(report.agents.map((agent) => agent.name)).toContain("Kora")
    })

    it("leaves the speed unreported when no round was won", () => {
      const report = buildReport([
        ...turn(0, {content: '{"moves":["MoveUp"]}'}),
        entry(LOG_EVENTS.levelLost, {outcome: "lost", traversalSpeed: "0.5000"}),
      ])

      // A lost round has no winning speed to classify, and defaulting it would invent a rank the log
      // never recorded.
      expect(report.traversalSpeed).toBeNull()
      expect(report.traversalSpeedClass).toBeNull()
    })
  })
})

// V5.Q1 asks whether any known cell was entered more times than its confirmed open-move count. That is
// the definition of Tapoo's `oscillating`, so the label answers it directly.
//
// Deriving it instead cannot see the case below: counting context.positions is one cell per turn, so a
// cell passed through inside a multi-move batch contributes nothing, and an exit count taken from
// filteredTraversalHistory skips any cell that has none.

describe("compacted log shape", () => {
  const compactStructure = (currentCell: [number, number], history: Array<[[number, number], string[]]>) =>
    toolMessage({
      currentCell,
      filteredTraversalHistory: history.map(([cell, openMoves]: [[number, number], string[]]) => ({
        playerName: "Katara",
        cell,
        openMoves: openMoves.map((move: string) => [move, "explored"]),
      })),
    })

  // A two-cell corridor: (0,0) opens down into (1,0), and nothing else is open anywhere.
  const compactedLog = [
    ...turn(0, {
      tools: ["get_maze_structure"],
      messages: [compactStructure([0, 0], [[[0, 0], ["MoveDown"]], [[1, 0], ["MoveUp"]]])],
      content: '{"moves":["MoveDown"]}',
    }),
    ...turn(1, {
      tools: ["get_maze_structure"],
      messages: [compactStructure([1, 0], [[[0, 0], ["MoveDown"]], [[1, 0], ["MoveUp"]]])],
      content: '{"moves":["MoveUp"]}',
    }),
  ]

  it("reads real cell keys and move names, not undefined and array indices", () => {
    const report = buildReport(compactedLog)
    const level = firstLevel(report)

    expect([...level.observedExits.keys()]).toEqual(["0,0", "1,0"])
    expect([...(level.observedExits.get("0,0") ?? [])]).toEqual(["MoveDown"])
    expect(level.positions).toEqual(["0,0", "1,0"])
  })

  it("does not confirm a context violation for moves the maze allows", () => {
    // Every submitted move is an exit the log states outright, so V4 has nothing to fire on. Before the
    // shape fix this answered YES, accusing the model on the strength of a junk exit set.
    expect(group(buildReport(compactedLog), "V4").met).toBe(false)
  })

  it("confirms a context violation for a move the maze forbids", () => {
    const walledLog = [
      ...turn(0, {
        tools: ["get_maze_structure"],
        messages: [compactStructure([0, 0], [[[0, 0], ["MoveDown"]]])],
        content: '{"moves":["MoveRight"]}',
      }),
    ]

    expect(group(buildReport(walledLog), "V4").met).toBe(true)
  })

  it("reads the uncompacted shape too, which older logs carry", () => {
    const uncompacted = [
      ...turn(0, {
        tools: ["get_maze_structure"],
        messages: [
          toolMessage({
            currentCell: {row: 0, col: 0},
            filteredTraversalHistory: [
              {cell: {row: 0, col: 0}, openMoves: {MoveDown: {row: 1, col: 0}}},
            ],
          }),
        ],
        content: '{"moves":["MoveDown"]}',
      }),
    ]

    expect([...firstLevel(buildReport(uncompacted)).observedExits.keys()]).toEqual(["0,0"])
  })
})

describe("C5 resource efficiency", () => {
  const rules = (cells: number, decay: number) =>
    toolMessage({suggestedMovesPerTurn: 2, playerUniqueCellsVisited: cells, decayUnitsCharged: decay})

  it("uses the settled round-end totals rather than the last mid-round reading", () => {
    // The rubric asks this at round end and requires the winning turn to be counted. Mid-round the
    // agent reads 15/16 = 0.9375; the round settles at 17/17 = 1.0000, which is the answer.
    const report = buildReport([
      ...turn(0, {tools: ["get_prediction_rules"], messages: [rules(15, 16)], content: '{"moves":["MoveUp"]}'}),
      entry(LOG_EVENTS.levelWon, {
        outcome: "won",
        traversalSpeed: "1.0000",
        agent: {playerName: "Katara"},
        playerUniqueCellsVisited: 17,
        decayUnitsCharged: 17,
      }),
    ])

    expect(group(report, "C5").met).toBe(true)
  })

  it("falls back to the last reading when the round end records no totals", () => {
    // Older logs end a round without those fields. Reading them as zero would answer no for a round the
    // per-turn readings already prove efficient.
    const report = buildReport([
      ...turn(0, {tools: ["get_prediction_rules"], messages: [rules(4, 2)], content: '{"moves":["MoveUp"]}'}),
      entry(LOG_EVENTS.levelWon, {outcome: "won", traversalSpeed: "2.0000", agent: {playerName: "Blue"}}),
    ])

    expect(group(report, "C5").met).toBe(true)
  })
})
