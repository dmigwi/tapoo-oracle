import { describe, expect, it } from "vitest"

import { LOG_EVENTS } from "../contracts/log-contract.js"
import { CAPABILITIES, VIOLATIONS, aggregate, answerRubric, parsePrediction } from "./rubric-engine.js"

// A log is a sequence of entries, and every question below is answered from what those entries do or
// do not contain. These builders keep each test to the entries it is actually about: anything a test
// does not add is absent from the log, which is the state the rubric answers NO for.
let clock = 0

function entry(payload, details, {log = "info", turn = 0} = {}) {
  clock += 1000
  return {epochMs: clock, time: "2026-08-31T09-00-00+02-00", level: 1, game: 1, turn, log, payload, details}
}

const toolMessage = (payload) => ({role: "tool", content: JSON.stringify(payload)})

// One turn: the request carrying whichever tool results it read, then the model's reply.
function turn(number, {tools = [], content, messages = []} = {}) {
  return [
    entry(LOG_EVENTS.request, {tools: tools.map((name) => ({name})), messages}, {turn: number}),
    entry(LOG_EVENTS.response, {payload: {model: "test-model", message: {content}}}, {turn: number}),
  ]
}

const group = (report, id) =>
  [...report.capabilities, ...report.violations].find((candidate) => candidate.id === id)

describe("aggregate", () => {
  // The two kinds read the same answers in opposite directions, and the whole report depends on it:
  // a capability is claimed only on complete evidence, a violation on any single piece.
  it("requires every answer for a capability", () => {
    expect(aggregate({a: true, b: true}, "capability")).toBe(true)
    expect(aggregate({a: true, b: false}, "capability")).toBe(false)
  })

  it("needs only one answer for a violation", () => {
    expect(aggregate({a: false, b: true}, "violation")).toBe(true)
    expect(aggregate({a: false, b: false}, "violation")).toBe(false)
  })

  // A question that returned undefined would otherwise count as a quiet NO, turning a broken
  // evaluator into a clean-looking report rather than an error.
  it("refuses an answer that is not a boolean", () => {
    expect(() => aggregate({a: true, b: undefined}, "capability")).toThrow(/non-boolean/)
  })
})

describe("parsePrediction", () => {
  it("reads a bare JSON prediction at the highest tier", () => {
    expect(parsePrediction('{"moves":["MoveUp"]}')).toMatchObject({moves: ["MoveUp"], tier: 1})
  })

  // Tier is what C1.Q1 reads: a fenced or embedded prediction is still usable, but it is not the
  // bare JSON the prompt asked for, and the report has to be able to say so.
  it("recovers a fenced prediction and marks it as a lower tier", () => {
    expect(parsePrediction('```json\n{"moves":["MoveUp"]}\n```')).toMatchObject({tier: 2})
  })

  it("recovers a prediction embedded in prose at the lowest tier", () => {
    expect(parsePrediction('Sure! Here it is: {"moves":["MoveUp"]}')).toMatchObject({tier: 3})
  })

  it("returns null for JSON that carries no moves key", () => {
    expect(parsePrediction('{"steps":["MoveUp"]}')).toBeNull()
  })

  it("returns null for empty or absent content", () => {
    expect(parsePrediction("   ")).toBeNull()
    expect(parsePrediction(undefined)).toBeNull()
  })
})

describe("answerRubric", () => {
  it("answers every group defined by the rubric, with fractions preserved", () => {
    const report = answerRubric(turn(0, {content: '{"moves":["MoveUp"]}'}))

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
    const report = answerRubric([entry(LOG_EVENTS.levelStarted, {level: 1})])

    // NO means the behavior was not observed in this sample. An empty log observes nothing, so no
    // capability may be claimed from it - and no violation may be charged either.
    expect(report.capabilities.every((entry) => entry.met === false)).toBe(true)
    expect(report.violations.every((entry) => entry.met === false)).toBe(true)
  })

  describe("C1 instruction adherence", () => {
    it("holds when the prediction is bare JSON with only a moves key", () => {
      const report = answerRubric(turn(0, {content: '{"moves":["MoveUp","MoveDown"]}'}))
      expect(group(report, "C1").met).toBe(true)
    })

    it("fails when the prediction arrives wrapped in a Markdown fence", () => {
      const report = answerRubric(turn(0, {content: '```json\n{"moves":["MoveUp"]}\n```'}))
      expect(group(report, "C1").answers.Q1).toBe(false)
      expect(group(report, "C1").met).toBe(false)
    })

    it("fails when the prediction carries a key beyond moves", () => {
      const report = answerRubric(turn(0, {content: '{"moves":["MoveUp"],"why":"corridor"}'}))
      expect(group(report, "C1").answers.Q2).toBe(false)
    })

    it("fails when a submitted command is not one of the four moves", () => {
      const report = answerRubric(turn(0, {content: '{"moves":["MoveSideways"]}'}))
      expect(group(report, "C1").answers.Q3).toBe(false)
    })
  })

  describe("C3 context acquisition", () => {
    it("holds only when every declared tool was read on the prediction turn", () => {
      const report = answerRubric(turn(0, {
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
      const report = answerRubric(turn(0, {
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
      const report = answerRubric([
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
      const report = answerRubric([
        ...turn(0, {content: '{"moves":["MoveUp"]}', messages: everyTool}),
        ...turn(1, {content: '{"moves":["MoveDown"]}', messages: everyTool}),
      ])

      expect(group(report, "C3").met).toBe(true)
    })
  })

  describe("V1 tool hallucination", () => {
    it("is confirmed by a single logged hallucinated tool call", () => {
      const report = answerRubric([
        ...turn(0, {content: '{"moves":["MoveUp"]}'}),
        entry(LOG_EVENTS.hallucinatedTool, {tool: "get_map_hint"}, {log: "warn"}),
      ])

      expect(group(report, "V1").met).toBe(true)
    })

    it("stays unconfirmed when no such call was logged", () => {
      const report = answerRubric(turn(0, {content: '{"moves":["MoveUp"]}'}))
      expect(group(report, "V1").met).toBe(false)
    })
  })

  describe("V2 output contract failure", () => {
    it("is confirmed by a response whose content yields no prediction", () => {
      const report = answerRubric(turn(0, {content: "I could not decide this turn."}))
      expect(group(report, "V2").answers.Q1).toBe(true)
      expect(group(report, "V2").met).toBe(true)
    })

    it("is confirmed by a response carrying neither content nor tool calls", () => {
      const report = answerRubric([
        entry(LOG_EVENTS.request, {tools: [], messages: []}),
        entry(LOG_EVENTS.response, {payload: {model: "test-model"}}),
      ])

      expect(group(report, "V2").answers.Q2).toBe(true)
    })
  })

  describe("operational diagnostics", () => {
    it("counts endpoint failures without charging them as a violation", () => {
      const report = answerRubric([
        ...turn(0, {content: '{"moves":["MoveUp"]}'}),
        entry(LOG_EVENTS.providerHttpFailure, {status: 429}, {log: "error"}),
        entry(LOG_EVENTS.requestFailed, {reason: "network"}, {log: "error"}),
      ])

      // Kept as evidence but never scored: a 429 is the provider's infrastructure, not the model's
      // reasoning, and charging it to the model would put someone else's outage in the profile.
      expect(report.diagnostics.endpointFailures).toBe(2)
      expect(report.violations.every((entry) => entry.met === false)).toBe(true)
    })

    it("counts a token cap exhaustion as both a diagnostic and resource waste", () => {
      const report = answerRubric([
        ...turn(0, {content: '{"moves":["MoveUp"]}'}),
        entry(LOG_EVENTS.tokenCapExhausted, {tokensUsage: 10000}, {log: "warn"}),
      ])

      expect(report.diagnostics.tokenExhaustions).toBe(1)
      expect(group(report, "V5").answers.Q3).toBe(true)
    })
  })

  describe("round outcome", () => {
    it("reports the winning traversal speed and its class", () => {
      const report = answerRubric([
        ...turn(0, {content: '{"moves":["MoveUp"]}'}),
        entry(LOG_EVENTS.levelWon, {outcome: "won", traversalSpeed: "1.5000", agent: {playerName: "Kora"}}),
      ])

      expect(report.rounds).toBe(1)
      expect(report.traversalSpeed).toBe(1.5)
      expect(report.traversalSpeedClass).toBe("Trailblazer")
      expect(report.player).toBe("Kora")
    })

    it("leaves the speed unreported when no round was won", () => {
      const report = answerRubric([
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

// Downloaded logs compact every get_maze_structure result before writing it: cells become [row, col]
// arrays and openMoves becomes [move, visitStatus] pairs. Only the uncompacted object form used to be
// read, so against a real export every cell key became "undefined,undefined" and every move name became
// an array index - which did not fail, it just answered C4, C7, V4 and V5 about nothing at all. These
// fixtures are in the shape a real download actually carries.
describe("compacted log shape", () => {
  const compactStructure = (currentCell, history) =>
    toolMessage({
      currentCell,
      filteredTraversalHistory: history.map(([cell, openMoves]) => ({
        playerName: "Katara",
        cell,
        openMoves: openMoves.map((move) => [move, "explored"]),
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
    const report = answerRubric(compactedLog)
    const level = report.levels[0]

    expect([...level.observedExits.keys()]).toEqual(["0,0", "1,0"])
    expect([...level.observedExits.get("0,0")]).toEqual(["MoveDown"])
    expect(level.positions).toEqual(["0,0", "1,0"])
  })

  it("does not confirm a context violation for moves the maze allows", () => {
    // Every submitted move is an exit the log states outright, so V4 has nothing to fire on. Before the
    // shape fix this answered YES, accusing the model on the strength of a junk exit set.
    expect(group(answerRubric(compactedLog), "V4").met).toBe(false)
  })

  it("confirms a context violation for a move the maze forbids", () => {
    const walledLog = [
      ...turn(0, {
        tools: ["get_maze_structure"],
        messages: [compactStructure([0, 0], [[[0, 0], ["MoveDown"]]])],
        content: '{"moves":["MoveRight"]}',
      }),
    ]

    expect(group(answerRubric(walledLog), "V4").met).toBe(true)
  })

  it("still reads the uncompacted shape, which older logs carry", () => {
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

    expect([...answerRubric(uncompacted).levels[0].observedExits.keys()]).toEqual(["0,0"])
  })
})

describe("C5 resource efficiency", () => {
  const rules = (cells, decay) =>
    toolMessage({suggestedMovesPerTurn: 2, playerUniqueCellsVisited: cells, decayUnitsCharged: decay})

  it("uses the settled round-end totals rather than the last mid-round reading", () => {
    // The rubric asks this at round end and requires the winning turn to be counted. Mid-round the
    // agent reads 15/16 = 0.9375; the round settles at 17/17 = 1.0000, which is the answer.
    const report = answerRubric([
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
    const report = answerRubric([
      ...turn(0, {tools: ["get_prediction_rules"], messages: [rules(4, 2)], content: '{"moves":["MoveUp"]}'}),
      entry(LOG_EVENTS.levelWon, {outcome: "won", traversalSpeed: "2.0000", agent: {playerName: "Blue"}}),
    ])

    expect(group(report, "C5").met).toBe(true)
  })
})

describe("buildLevels", () => {
  const round = (game, level, content) => [
    entry(LOG_EVENTS.levelStarted, {startPosition: {x: 1, y: 1}}, {turn: 0}),
    ...turn(0, {tools: ["get_maze_structure"], content}),
  ].map((record) => ({...record, game, level}))

  it("keeps a retry of the same level as its own round", () => {
    // A retry regenerates the maze, so grouping by level alone would merge two different mazes and draw
    // a path crossing walls that exist in neither.
    const report = answerRubric([
      ...round(1, 1, '{"moves":["MoveDown"]}'),
      ...round(2, 1, '{"moves":["MoveUp"]}'),
    ])

    expect(report.levels.map((level) => level.key)).toEqual(["1/1", "2/1"])
    expect(report.levels[0].startCell).toBe("0,0")
  })

  it("attributes a turn to the acting agent named in the request", () => {
    const report = answerRubric([
      entry(LOG_EVENTS.request, {
        player: "Katara the Trailblazer - Default",
        tools: [{name: "get_maze_structure"}],
        messages: [
          toolMessage({
            currentCell: [0, 0],
            filteredTraversalHistory: [{playerName: "Katara", cell: [0, 0], openMoves: [["MoveDown", "unvisited"]]}],
          }),
        ],
      }, {turn: 0}),
      entry(LOG_EVENTS.response, {payload: {model: "m", message: {content: '{"moves":["MoveDown"]}'}}}, {turn: 0}),
    ])

    expect(report.levels[0].turns[0].playerName).toBe("Katara")
  })

  it("records the refused move of a turn that was cut short", () => {
    const report = answerRubric([
      ...turn(0, {
        tools: ["get_maze_structure"],
        messages: [
          toolMessage({
            currentCell: [0, 0],
            filteredTraversalHistory: [{playerName: "K", cell: [0, 0], openMoves: [["MoveDown", "unvisited"]]}],
          }),
        ],
        content: '{"moves":["MoveDown","MoveUp"]}',
      }),
      entry(LOG_EVENTS.request, {
        tools: [{name: "get_last_prediction_outcome"}],
        messages: [
          toolMessage({
            lastMoveStatus: "invalid-move",
            lastSubmittedMoves: ["MoveDown", "MoveUp"],
            lastAppliedMoveIndex: 0,
            chargedMovesCount: 2,
          }),
        ],
      }, {turn: 1}),
    ])

    const [first] = report.levels[0].turns
    expect(first.applied).toBe(1)
    expect(first.rejectedMove).toBe("MoveUp")
    expect(first.cells).toEqual(["0,0", "1,0"])
  })
})
