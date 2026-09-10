import { describe, expect, it } from "vitest"

import {LOG_EVENTS} from "./log-contract"
import {VIOLATIONS, aggregate, buildContext, parsePrediction} from "./rubric-engine"
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

// The context buildReport builds is handed to buildLevels instead of a second identical one being
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
