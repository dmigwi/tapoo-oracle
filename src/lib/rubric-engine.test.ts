import { describe, expect, it } from "vitest"

import {LOG_EVENTS} from "./log-contract"
import {CAPABILITIES, VIOLATIONS, aggregate, buildContext, parsePrediction} from "./rubric-engine"
import type {LogEntry} from "./types"
import {at, must, rubricEntry as entry, rubricTurn as turn, toolMessage} from "./test-support";

// What buildContext reads out of a log, and the two pure helpers the questions are answered with. The
// report those answers are assembled into is rubric-report.test.ts, and the rounds they are attributed
// to is rounds.test.ts.

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
    expect(() => aggregate({a: true, b: undefined as unknown as boolean}, "capability")).toThrow(/non-boolean/)
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

// The context buildReport builds is handed to buildPlayedRounds instead of a second identical one being
// built over the same entries. That is only sound if the two produce the same levels, so this pins it
// against the real fixture rather than trusting the argument.
// A round's identity is the running cursor's, not its first entry's - Tapoo stamps game and level only
// at round boundaries, so the entries that open a group often carry neither.
//
// Reading them off `groupEntries[0]` while taking the key from the group makes one record say "7/3" and
// `game: null, level: null` at once, and the maze replay - which builds its level select from those
// numbers - says "Level null". One identity, one answer.

describe("V5.Q1, excess visits", () => {
  const answer = (entries: LogEntry[]) =>
    must(VIOLATIONS.find((group) => group.id === "V5"), "the V5 group").evaluate(buildContext(entries)).Q1

  const structure = (turnNumber: number, cell: [number, number], moves: Array<[string, string]>) =>
    turn(turnNumber, {
      messages: [
        toolMessage({
          currentCell: cell,
          filteredTraversalHistory: [{playerName: "Katara", cell, openMoves: moves}],
        }),
      ],
    })

  it("confirms the violation when Tapoo labelled any cell oscillating", () => {
    expect(answer(structure(0, [1, 1], [["MoveUp", "oscillating"]]))).toBe(true)
  })

  it("leaves it unconfirmed when no cell went past its exit count", () => {
    expect(answer(structure(0, [1, 1], [["MoveUp", "backtracking"], ["MoveDown", "explored"]]))).toBe(false)
  })

  // The shape a turn-boundary count cannot see: one turn, one tool result, and a cell the agent never ended
  // a turn on, so it never enters context.positions.
  it("sees a cell the turn-boundary count could never reach", () => {
    const entries = structure(0, [0, 0], [["MoveDown", "oscillating"]])
    const context = buildContext(entries)

    expect(context.positions).toEqual(["0,0"])
    expect(context.positions).not.toContain("1,0")
    expect(answer(entries)).toBe(true)
  })

  // A log with no statuses at all - an older export, or a round where get_maze_structure was never
  // called - still gets the derivation it always got, rather than a silent NO.
  it("falls back to the derivation when the log carries no statuses", () => {
    const entries = turn(0, {
      messages: [
        toolMessage({
          currentCell: {row: 0, col: 0},
          // Uncompacted and pre-visitStatus: exits are stated, grades are not.
          filteredTraversalHistory: [{playerName: "Katara", cell: {row: 0, col: 0}, openMoves: {MoveDown: {row: 1, col: 0}}}],
        }),
      ],
    })
    const context = buildContext(entries)

    expect(context.visitStatusAfterTurn.size).toBe(0)
    expect(context.exits.get("0,0")).toEqual(new Set(["MoveDown"]))
    expect(answer(entries)).toBe(false)
  })
})

// The status a cell carries is written on its neighbours' entries, never on its own: Tapoo's wording is
// "every openMoves entry ... includes the reached cell's visitStatus", and a history entry has no status
// field at all. Reading a pair as the entry cell's own status would shift the whole overlay one cell -
// wrong in a way that still looks plausible on screen, which is why it is pinned here.

describe("harvesting visit statuses", () => {
  const structure = (turnNumber: number, cell: [number, number], moves: Array<[string, string]>) =>
    turn(turnNumber, {
      messages: [
        toolMessage({
          currentCell: cell,
          filteredTraversalHistory: [{playerName: "Katara", cell, openMoves: moves}],
        }),
      ],
    })

  it("credits the status to the cell the move reaches, not to the cell that reported it", () => {
    const context = buildContext(structure(0, [1, 1], [["MoveUp", "backtracking"], ["MoveRight", "oscillating"]]))

    // Stored under -1: turn 0's payload describes the world before the first turn.
    expect([...must(context.visitStatusAfterTurn.get(-1), "the opening statuses")]).toEqual([
      ["0,1", "backtracking"],
      ["1,2", "oscillating"],
    ])
    // The reporting cell learns nothing about itself from its own entry.
    expect(context.visitStatusAfterTurn.get(-1)?.has("1,1")).toBe(false)
  })

  // The rule, asserted where it is applied. A payload logged on turn N describes turn N - 1, and every
  // consumer looks up the turn it wants - so a `+ 1` reappearing anywhere downstream contradicts this.
  it("stores a payload under the turn it describes, not the turn that carried it", () => {
    const context = buildContext([
      ...structure(0, [1, 1], [["MoveUp", "explored"]]),
      ...structure(1, [1, 1], [["MoveUp", "oscillating"]]),
      ...structure(2, [1, 1], [["MoveUp", "backtracking"]]),
    ])

    expect(context.visitStatusAfterTurn.ascending().map(([turn]) => turn)).toEqual([-1, 0, 1])
    expect(context.visitStatusAfterTurn.get(-1)?.get("0,1")).toBe("explored")
    expect(context.visitStatusAfterTurn.get(0)?.get("0,1")).toBe("oscillating")
    expect(context.visitStatusAfterTurn.get(1)?.get("0,1")).toBe("backtracking")
  })

  it("records nothing for a turn whose payload carried no status", () => {
    const context = buildContext(structure(0, [1, 1], []))
    expect(context.visitStatusAfterTurn.size).toBe(0)
  })
})

// Downloaded logs compact every get_maze_structure result before writing it: cells become [row, col]
// arrays and openMoves becomes [move, visitStatus] pairs. Reading only the uncompacted object form turns
// every cell key of a real export into "undefined,undefined" and every move name into an array index -
// which does not fail, it answers C4, C7, V4 and V5 about nothing at all. These fixtures are in the shape
// a real download actually carries.

describe("how buildContext decides which turn an entry belongs to", () => {
  // Three regimes, and the index picks between them. The first is what every current log uses; the
  // other two exist because older logs are still analyzed rather than refused.
  it("reads each entry's own turn when the index placed them all", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {tools: [], messages: []}, {turn: 0}),
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveUp"]}'}}}, {turn: 0}),
      entry(LOG_EVENTS.request, {tools: [], messages: []}, {turn: 1}),
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveDown"]}'}}}, {turn: 1}),
    ])

    expect(context.submissions.map((s) => s.turn)).toEqual([0, 1])
    expect([...context.turnsWithPrediction].sort()).toEqual([0, 1])
  })

  it("attributes an entry to its own turn, not to whichever request preceded it", () => {
    // A cursor moving only on request entries leaves anything between two requests inheriting the earlier
    // one's number. Here the response says turn 4 and there is no request for it, so a cursor would file
    // the prediction under turn 0.
    const context = buildContext([
      entry(LOG_EVENTS.request, {tools: [], messages: []}, {turn: 0}),
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveUp"]}'}}}, {turn: 4}),
    ])

    expect(context.submissions.map((s) => s.turn)).toEqual([4])
  })

  it("infers boundaries from predictions when no entry carries a turn", () => {
    // Without this every entry collapses onto turn 0 and the per-turn questions pass trivially, which is
    // worse than being unable to answer them.
    const withoutTurns = [
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveUp"]}'}}}),
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveDown"]}'}}}),
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveLeft"]}'}}}),
    ].map((logEntry) => {
      const copy: Partial<LogEntry> = {...logEntry}
      delete copy.turn
      return copy as LogEntry
    })

    expect(buildContext(withoutTurns).submissions.map((s) => s.turn)).toEqual([0, 1, 2])
  })

  it("trusts the field on a log where only some entries carry a turn", () => {
    // The index will not place these - its spans have to tile the array - but a turn number that is
    // present is still better evidence than a cursor counting predictions.
    const partial: LogEntry[] = [
      entry(LOG_EVENTS.request, {tools: [], messages: []}, {turn: 7}),
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveUp"]}'}}}, {turn: 7}),
    ]
    const stripped: Partial<LogEntry> = {...at(partial, 1)}
    delete stripped.turn

    const context = buildContext([at(partial, 0), stripped as LogEntry])
    expect(context.submissions.map((s) => s.turn)).toEqual([7])
  })
})

describe("an OpenAI-shaped provider response", () => {
  // End to end through buildContext, not just the reader: the point is that a prediction logged this
  // way becomes a submission, which is what the turn count, the replay and every per-turn question are
  // built from.
  const openAiResponse = (content: string, turn: number): LogEntry =>
    entry(LOG_EVENTS.response, {payload: {model: "glm-5.3", choices: [{finish_reason: "stop",
      message: {role: "assistant", content}}]}}, {turn})

  it("becomes a submission, not an empty response", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {tools: [], messages: []}, {turn: 0}),
      openAiResponse('{"moves":["MoveUp"]}', 0),
    ])

    expect(context.submissions.map((s) => s.moves)).toEqual([["MoveUp"]])
    expect(context.emptyResponses).toBe(0)
  })

  it("has its tool calls read from the same place", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {tools: [{name: "get_maze_structure"}], messages: []}, {turn: 0}),
      entry(LOG_EVENTS.response, {payload: {choices: [{finish_reason: "tool_calls", message: {content: "",
        tool_calls: [{function: {name: "get_maze_structure", arguments: "{}"}}]}}]}}, {turn: 0}),
    ])

    expect(context.toolCalls).toEqual(["get_maze_structure"])
    expect(context.emptyResponses).toBe(0)
  })

  it("names the model from the payload root, as the other shape does", () => {
    expect(buildContext([openAiResponse('{"moves":["MoveUp"]}', 0)]).model).toBe("glm-5.3")
  })
})

describe("an Anthropic-shaped provider response", () => {
  // Anthropic has no `message` and no `choices` - content is a top-level array of typed blocks, and
  // tool calls are `tool_use` entries rather than a tool_calls list. Before the contract read all
  // three shapes, every Anthropic response would have counted as empty, exactly as every OpenAI one
  // did: zero predictions, zero turns, and a replay scrubber reading "0 / 0".
  const anthropic = (content: unknown[], turn: number): LogEntry =>
    entry(LOG_EVENTS.response, {payload: {model: "claude", role: "assistant", content,
      usage: {input_tokens: 3100, output_tokens: 24}}}, {turn})

  it("becomes a submission, not an empty response", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {tools: [], messages: []}, {turn: 0}),
      anthropic([{type: "thinking", thinking: "considering"},
        {type: "text", text: '{"moves":["MoveUp"]}'}], 0),
    ])

    expect(context.submissions.map((s) => s.moves)).toEqual([["MoveUp"]])
    expect(context.emptyResponses).toBe(0)
  })

  it("has its tool calls read from tool_use blocks", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {tools: [{name: "get_maze_structure"}], messages: []}, {turn: 0}),
      anthropic([{type: "tool_use", id: "call_1", name: "get_maze_structure", input: {}}], 0),
    ])

    expect(context.toolCalls).toEqual(["get_maze_structure"])
    expect(context.emptyResponses).toBe(0)
  })

  it("counts its tokens into the model output summary", () => {
    const context = buildContext([anthropic([{type: "text", text: '{"moves":["MoveUp"]}'}], 0)])

    expect(context.output.promptTokens).toBe(3100)
    expect(context.output.completionTokens).toBe(24)
  })
})

// The paths a clean log never takes. Each is reachable from a real export - a provider that answered
// with something other than JSON, a turn that read the maze twice, a round that ended - and each was
// unexercised until now, which is how a defensive branch stops defending.
describe("what buildContext does with a tool result it cannot read", () => {
  const withToolContent = (content: unknown): LogEntry[] => [
    entry(LOG_EVENTS.request, {tools: [], messages: [{role: "tool", content}]}, {turn: 0}),
    entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveUp"]}'}}}, {turn: 0}),
  ]

  // Not JSON at all. Parsing throws, and a throw here leaves the whole report unrendered rather than
  // one turn unread, so the entry is skipped and the rest of the log still answers.
  it("skips a tool result that is not JSON, and reads the rest of the log", () => {
    const context = buildContext(withToolContent("<html>502 Bad Gateway</html>"))

    expect(context.exits.size).toBe(0)
    expect(context.positions).toEqual([])
    // The turn's prediction is still read: the unreadable result cost the tool reading, nothing else.
    expect(context.submissions).toHaveLength(1)
  })

  // Valid JSON, but not an object: "null" and "3" parse without throwing and have no keys to read.
  // Reaching for `payload.currentCell` on either is what a truthiness check alone would allow.
  it("skips a tool result that parses to something with no fields", () => {
    for (const content of ["null", "3", '"a string"']) {
      const context = buildContext(withToolContent(content))

      expect(context.positions).toEqual([])
      expect(context.declaredTools.size).toBe(0)
    }
  })
})

// Two tool results in one turn, both reporting statuses. The store merges rather than overwrites, so
// the turn ends holding both readings - overwriting would drop whichever arrived first, and a cell's
// status would depend on which tool message the model happened to read last.
describe("two readings of the maze in one turn", () => {
  const historyOf = (cell: [number, number], move: string, status: string) => toolMessage({
    filteredTraversalHistory: [{
      cell: {row: cell[0], col: cell[1]},
      openMoves: {[move]: {row: cell[0] + 1, col: cell[1], visitStatus: status}},
    }],
  })

  it("merges both readings into the turn, keeping the cells each one named", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {
        tools: [],
        messages: [historyOf([0, 0], "MoveDown", "explored"), historyOf([1, 0], "MoveDown", "oscillating")],
      }, {turn: 0}),
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveDown"]}'}}}, {turn: 0}),
    ])

    // Recorded under the turn the reading covers, which is the one before the request that carried it.
    const [turnCovered, statuses] = at(context.visitStatusAfterTurn.ascending(), 0)
    expect(turnCovered).toBe(-1)
    expect([...statuses]).toEqual([["1,0", "explored"], ["2,0", "oscillating"]])
  })
})

// V3 asks whether the model repeated a tool call after being told not to, and this event is the only
// proof of it: a warned-mode request shows the harness warned, never that the model ignored it.
describe("a duplicate tool call after a warning", () => {
  it("counts the event, and V3.Q1 confirms the violation", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {tools: [], messages: []}, {turn: 0}),
      entry(LOG_EVENTS.duplicateToolWarningIgnored, {}, {log: "warn", turn: 0}),
    ])

    expect(context.duplicatesAfterWarning).toBe(1)
    const v3 = must(VIOLATIONS.find((group) => group.id === "V3"), "the warning-disregard group")
    expect(v3.evaluate(context)).toEqual({Q1: true})
  })

  it("leaves it unconfirmed when no such event was logged", () => {
    const context = buildContext([entry(LOG_EVENTS.request, {tools: [], messages: []}, {turn: 0})])

    expect(context.duplicatesAfterWarning).toBe(0)
    expect(must(VIOLATIONS.find((group) => group.id === "V3"), "the group").evaluate(context))
      .toEqual({Q1: false})
  })
})

// The last turn of a round reports its replay on the outcome entry rather than on a following request,
// there being no following request. Without reading it there, the final turn's move is never replayed.
describe("the replay an outcome carries", () => {
  it("takes the outcome's own last action as a replay", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {tools: [], messages: []}, {turn: 0}),
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveDown"]}'}}}, {turn: 0}),
      entry(LOG_EVENTS.levelWon, {
        outcome: "won",
        traversalSpeed: "1.0000",
        agent: {playerName: "Katara"},
        lastActionResult: {lastMoveStatus: "applied", lastSubmittedMoves: ["MoveDown"], lastAppliedMoveIndex: 0},
      }, {turn: 1}),
    ])

    expect(context.replays.map((replay) => replay.lastMoveStatus)).toEqual(["applied"])
    expect(context.player).toBe("Katara")
  })

  it("takes nothing from an outcome whose last action reports no move status", () => {
    const context = buildContext([
      entry(LOG_EVENTS.levelLost, {outcome: "lost", lastActionResult: {lastSubmittedMoves: []}}, {turn: 1}),
    ])

    expect(context.replays).toEqual([])
  })
})

// The other half of each two-shape reader, and the cells a log names but cannot place. None of these
// throw when they go unhandled - they quietly drop a tool, a cell or a reading - so each is asserted
// rather than assumed.
describe("the shapes a log can state a fact in", () => {
  // Tools arrive flat in a log and nested under `function` on the wire. An unreadable declaration
  // leaves declaredTools empty, which makes every legitimate call look hallucinated.
  it("declares a tool named under `function` as readily as a flat one", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {tools: [{function: {name: "get_maze_structure"}}], messages: []}, {turn: 0}),
    ])

    expect([...context.declaredTools]).toEqual(["get_maze_structure"])
  })

  it("declares nothing from a tool entry that names itself in neither place", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {tools: [{description: "no name here"}], messages: []}, {turn: 0}),
    ])

    expect(context.declaredTools.size).toBe(0)
  })

  // A tool message whose content is not a string at all - a provider that sent an object where the
  // protocol says text. `JSON.parse` is handed "" rather than a non-string, so it throws and the
  // message is skipped instead of reaching the readers below it.
  it("skips a tool message whose content is not text", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {
        tools: [], messages: [{role: "tool", content: {currentCell: {row: 0, col: 0}}}],
      }, {turn: 0}),
    ])

    expect(context.positions).toEqual([])
  })

  // A history record and a position reading whose cell cannot be read. Both are skipped: an exit list
  // filed under a cell nobody can name would answer no question, and a position that is not a cell
  // would put a step in the walk that the maze has no square for.
  it("skips a history record and a position whose cell it cannot read", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {
        tools: [],
        messages: [
          toolMessage({filteredTraversalHistory: [{cell: null, openMoves: {MoveDown: {visitStatus: "explored"}}}]}),
          toolMessage({currentCell: "not a cell"}),
        ],
      }, {turn: 0}),
    ])

    expect(context.exits.size).toBe(0)
    expect(context.positions).toEqual([])
    // The call was still counted for the turn - noteTool records that the maze was read, whatever the
    // reading turned out to hold - so an unreadable cell does not make the call look hallucinated.
    expect([...must(context.turnTools.get(0), "the turn's tools")]).toEqual(["get_maze_structure"])
  })

  // A prediction-rules reading that states the rules and neither figure. Read as zeroes rather than
  // skipped: the reading happened, and a missing counter is Tapoo not having moved it yet.
  it("reads a prediction-rules payload that states no figures as zeroes", () => {
    const context = buildContext([
      entry(LOG_EVENTS.request, {
        tools: [], messages: [toolMessage({suggestedMovesPerTurn: 3})],
      }, {turn: 0}),
    ])

    expect(context.speedReadings).toEqual([[0, 0]])
  })
})

// Two questions whose YES arm no test had ever reached: both are answered by walking the round's
// submissions in order, and both need a *pair* of turns arranged just so - which no fixture had.
describe("C8.Q1, adaptive recovery", () => {
  const answer = (entries: LogEntry[]) =>
    must(CAPABILITIES.find((group) => group.id === "C8"), "the C8 group").evaluate(buildContext(entries)).Q1

  // The turn after a refused prediction lands its first two moves. One applied move would prove
  // nothing - the open exits of the current cell are handed to the model on every tool call, so
  // repeating one back is transcription; the second is the first move that needs reasoning.
  it("confirms recovery when the turn after a failure lands two consecutive moves", () => {
    expect(answer([
      ...turn(0, {content: '{"moves":["MoveUp","MoveUp"]}'}),
      entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({
        lastMoveStatus: "invalid-move", lastSubmittedMoves: ["MoveUp", "MoveUp"], lastAppliedMoveIndex: -1,
        lastReplayStartCell: [0, 0],
      })]}, {turn: 1}),
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveDown","MoveRight"]}'}}}, {turn: 1}),
      entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({
        lastMoveStatus: "applied", lastSubmittedMoves: ["MoveDown", "MoveRight"], lastAppliedMoveIndex: 1,
        lastReplayStartCell: [0, 0],
      })]}, {turn: 2}),
    ])).toBe(true)
  })

  // The same failure, and a recovery that lands only its first move: transcription, not reasoning.
  it("does not confirm it when the following turn lands only one move", () => {
    expect(answer([
      ...turn(0, {content: '{"moves":["MoveUp","MoveUp"]}'}),
      entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({
        lastMoveStatus: "invalid-move", lastSubmittedMoves: ["MoveUp", "MoveUp"], lastAppliedMoveIndex: -1,
        lastReplayStartCell: [0, 0],
      })]}, {turn: 1}),
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveDown","MoveRight"]}'}}}, {turn: 1}),
      entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({
        lastMoveStatus: "invalid-move", lastSubmittedMoves: ["MoveDown", "MoveRight"], lastAppliedMoveIndex: 0,
        lastReplayStartCell: [0, 0],
      })]}, {turn: 2}),
    ])).toBe(false)
  })
})

describe("V6.Q1, failed-state repetition", () => {
  const answer = (entries: LogEntry[]) =>
    must(VIOLATIONS.find((group) => group.id === "V6"), "the V6 group").evaluate(buildContext(entries)).Q1

  // The cell reading is what gives a submission its `before`, and a prediction with no cell behind it
  // is skipped by this question: the same moves from two different cells are two different predictions.
  const at00 = () => toolMessage({currentCell: {row: 0, col: 0}})
  const outcomeOf = (moves: string[], applied: number) => toolMessage({
    lastMoveStatus: applied > 0 ? "applied" : "invalid-move",
    lastSubmittedMoves: moves,
    lastAppliedMoveIndex: applied - 1,
    lastReplayStartCell: [0, 0],
  })

  const twice = (moves: string[], applied: number): LogEntry[] => [
    entry(LOG_EVENTS.request, {tools: [], messages: [at00()]}, {turn: 0}),
    entry(LOG_EVENTS.response, {payload: {message: {content: JSON.stringify({moves})}}}, {turn: 0}),
    entry(LOG_EVENTS.request, {tools: [], messages: [at00(), outcomeOf(moves, applied)]}, {turn: 1}),
    entry(LOG_EVENTS.response, {payload: {message: {content: JSON.stringify({moves})}}}, {turn: 1}),
    entry(LOG_EVENTS.request, {tools: [], messages: [at00(), outcomeOf(moves, applied)]}, {turn: 2}),
  ]

  // The same moves, from the same cell, after that exact list applied nothing.
  it("confirms the repeat of a prediction already proven invalid from that cell", () => {
    expect(answer(twice(["MoveUp"], 0))).toBe(true)
  })

  // The same list, tried twice, but it applied - so nothing was ever proven invalid, and there is no
  // failed state to repeat.
  it("does not confirm a repeat of a prediction that worked", () => {
    expect(answer(twice(["MoveDown"], 1))).toBe(false)
  })
})

// How many moves landed, when the log never says outright. annotateApplied prefers the replay result
// and falls back to triangulating between the cell readings either side of the prediction.
describe("resolving how many moves applied", () => {
  const submissionsOf = (entries: LogEntry[]) =>
    buildContext(entries).submissions.map((record) => [record.before, record.applied])

  // A prediction naming something the maze has no move for. The walk stops there rather than stepping
  // an unknown name: `moves` is a model's own JSON, so it can hold any string at all.
  it("gives up the walk at a move the maze cannot apply", () => {
    expect(submissionsOf([
      entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({currentCell: {row: 0, col: 0}})]}, {turn: 0}),
      entry(LOG_EVENTS.response, {
        payload: {message: {content: '{"moves":["Teleport","MoveDown"]}'}},
      }, {turn: 0}),
      entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({currentCell: {row: 1, col: 0}})]}, {turn: 1}),
    ])).toEqual([["0,0", null]])
  })

  // The agent moved, and the prefix that lands on the cell it was next seen at is what applied.
  it("counts the prefix that lands on the cell the agent was next seen at", () => {
    expect(submissionsOf([
      entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({currentCell: {row: 0, col: 0}})]}, {turn: 0}),
      entry(LOG_EVENTS.response, {
        payload: {message: {content: '{"moves":["MoveDown","MoveRight"]}'}},
      }, {turn: 0}),
      entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({currentCell: {row: 1, col: 0}})]}, {turn: 1}),
    ])).toEqual([["0,0", 1]])
  })

  // A replay that reports the moves but not how far they got. Read as none applied rather than as a
  // missing reading: the result was stated, and what it states is that nothing landed.
  it("reads a replay with no applied index as nothing applied", () => {
    expect(submissionsOf([
      entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({currentCell: {row: 0, col: 0}})]}, {turn: 0}),
      entry(LOG_EVENTS.response, {payload: {message: {content: '{"moves":["MoveUp"]}'}}}, {turn: 0}),
      entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({
        lastMoveStatus: "invalid-move", lastSubmittedMoves: ["MoveUp"], lastReplayStartCell: [0, 0],
      })]}, {turn: 1}),
    ])).toEqual([["0,0", 0]])
  })
})

// C7.Q1 asks for a batch through structure already proven branchless: the cell the agent stands on and
// the one the first move leads into are both confirmed two-exit corridors. That is the shape where
// batching costs nothing extra, and single-stepping wastes a free decay unit.
describe("C7.Q1, a batch through confirmed corridor", () => {
  const answer = (entries: LogEntry[]) =>
    must(CAPABILITIES.find((group) => group.id === "C7"), "the C7 group").evaluate(buildContext(entries)).Q1

  // Two exits each, which is what makes a cell a corridor: nothing to choose between, so the next step
  // is forced and the agent can commit to it without another reading.
  const corridor = (cell: [number, number], moves: string[]) => ({
    cell: {row: cell[0], col: cell[1]},
    openMoves: Object.fromEntries(moves.map((move) => [move, {visitStatus: "unexplored"}])),
  })

  const batchOf = (history: Array<ReturnType<typeof corridor>>, moves: string[]): LogEntry[] => [
    entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({
      currentCell: {row: 0, col: 0}, filteredTraversalHistory: history,
    })]}, {turn: 0}),
    entry(LOG_EVENTS.response, {payload: {message: {content: JSON.stringify({moves})}}}, {turn: 0}),
    entry(LOG_EVENTS.request, {tools: [], messages: [toolMessage({
      lastMoveStatus: "applied", lastSubmittedMoves: moves, lastAppliedMoveIndex: moves.length - 1,
      lastReplayStartCell: [0, 0],
    })]}, {turn: 1}),
  ]

  it("confirms it when both the cell and the one ahead are known corridors", () => {
    expect(answer(batchOf(
      [corridor([0, 0], ["MoveDown", "MoveRight"]), corridor([1, 0], ["MoveUp", "MoveDown"])],
      ["MoveDown", "MoveDown"],
    ))).toBe(true)
  })

  // The cell ahead has three exits, so the second move was a choice rather than a forced step - the
  // agent batched through a junction it had no reading for.
  it("leaves it unconfirmed when the cell ahead is a junction", () => {
    expect(answer(batchOf(
      [corridor([0, 0], ["MoveDown", "MoveRight"]), corridor([1, 0], ["MoveUp", "MoveDown", "MoveRight"])],
      ["MoveDown", "MoveDown"],
    ))).toBe(false)
  })
})
