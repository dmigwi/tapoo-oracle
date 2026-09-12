// The rubric's context: one walk over a round's entries, turned into everything the questions are
// answered from.
//
// Named for what it produces rather than for what it does to it. The engine that ran the rubric is
// gone from here - the questions and their verdicts live in rubric-report.ts - and what remains builds
// a Context and hands it over.
//
// It answers nothing itself. buildContext reads what the log states - predictions, positions, exits,
// visit statuses, replays, tool calls, the counters behind the diagnostics - and returns it as data.
// Keeping that apart from the questions means a change to what a question asks cannot quietly change
// what was read to answer it.
//
// Like log-contract.ts, this file must stay free of node: imports so it can be bundled for the browser.
//
// Every shared derivation happens once, here. A question needing a fact this does not hold is a change
// to buildContext, not a second walk in the question.

import {
  LOG_EVENTS,
  assistantMessage,
  responseUsage,
  stepFrom,
  cellKeyFromLogged,
  isMove,
  openMovesFromLogged,
  statusesFromLogged,
  turnReports,
} from "./log-contract"
import {turnsAreStated} from "./geometry"
import {asArray, asRecord} from "./utils"
import type {
  Replay,
  VisitStatus,
  CellKey,
  Context,
  LogEntry,
  Move,
  Outcome,
  TurnPrediction,
  RawTurnSetup,
} from "./types"

// --- Reading a log entry ---

// How much of an over-full prediction's field list is worth keeping. The same 25 characters Tapoo
// compacts a logged text to, and for the same reason: the opening names answer the question, and a
// model that returned a dozen fields has proved the point long before the list ends.
const KEY_LIST_HEAD = 25
const trimmedKeyList = (keys: string[]): string => {
  const named = keys.join(", ")
  return named.length > KEY_LIST_HEAD ? `${named.slice(0, KEY_LIST_HEAD)}...` : named
}

/** parseTurnPrediction recovers the moves array a model submitted, mirroring the three tiers
 * frontend/app/agent/protocol.ts accepts: bare JSON, a fenced block, or a trailing object after
 * prose. The tier matters on its own - it is what C1.Q1 scores - so it is returned, not discarded. */
export function parseTurnPrediction(content: unknown): Omit<TurnPrediction, "turn"> | null {
  if (typeof content !== "string" || !content.trim()) {
    return null
  }

  const text = content.trim()
  const candidates: Array<[string, TurnPrediction["tier"]]> = [[text, 1]]

  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenced?.[1]) {
    candidates.push([fenced[1].trim(), 2])
  }

  const embedded = text.lastIndexOf("{")
  if (embedded !== -1) {
    candidates.push([text.slice(embedded).trim(), 3])
  }

  for (const [candidate, tier] of candidates) {
    try {
      // JSON.parse is `any`; narrowing here is what stops an arbitrary model response being carried
      // into the rubric as if its shape were known. Nothing past this function sees the model's own
      // JSON: what it sent is reported as a count and a prefix, and its excess fields as one string.
      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === "object" && "moves" in parsed) {
        // A `moves` that is not a list is a malformed prediction, and it becomes an empty one rather
        // than a one-move one: wrapping it would let `{"moves": "MoveUp"}` be scored as a valid single
        // move, which is the opposite of what the questions are asking.
        //
        // The difference between "no moves key" and "a moves key holding junk" survives all the same:
        // the branch above returns null for the first, so it is counted as a response nothing could be
        // read from, while the second is a prediction that submitted none.
        const moves: unknown = parsed.moves
        const submitted: unknown[] = Array.isArray(moves) ? moves : []

        // Narrowed once, here, so nothing downstream repeats it: the applicable prefix ends at the
        // first command the maze has no move for, which is where Tapoo's own replay stops too.
        const applicable: Move[] = []
        for (const move of submitted) {
          if (!isMove(move)) break
          applicable.push(move)
        }

        return {
          moves: applicable,
          submittedCount: submitted.length,
          tier,
          // A prediction always holds `moves` - the branch above requires it - so what is left after
          // dropping it is exactly the excess C1.Q2 reports.
          invalidFormatKeys: trimmedKeyList(Object.keys(parsed).filter((key) => key !== "moves")),
        }
      }
    } catch {
      // Candidate was not JSON; fall through to the next tier.
    }
  }

  return null
}

// --- Building the context ---

const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null)
const booleanOrNull = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null)
const textOrNull = (value: unknown): string | null =>  typeof value === "string" && value !== "" ? value : null

/** Merges what one entry said about a turn's seat into what is already known about it.
 *
 * Merged rather than overwritten because the facts arrive on two entries - the request carries the seat,
 * the model it was configured with, the provider and the effort; the response carries the provider's
 * echo of that model - and a turn is one seat's, so neither should erase the other. Only fields with
 * something to say are written. */
function noteSetup(context: Context, turn: number, seen: Partial<RawTurnSetup>): void {
  const known = context.rawSetupByTurn.get(turn) ?? {
    seatId: null, model: null, echoedModel: null, api: null, endpoint: null, reasoning: null,
    echoBackReasoning: null, requestIntervalSeconds: null,
  }
  context.rawSetupByTurn.set(turn, {
    seatId: seen.seatId ?? known.seatId,
    model: seen.model ?? known.model,
    echoedModel: seen.echoedModel ?? known.echoedModel,
    api: seen.api ?? known.api,
    endpoint: seen.endpoint ?? known.endpoint,
    reasoning: seen.reasoning ?? known.reasoning,
    // `??` rather than a truthiness test: false is a stated setting, and it is the interesting one.
    echoBackReasoning: seen.echoBackReasoning ?? known.echoBackReasoning,
    requestIntervalSeconds: seen.requestIntervalSeconds ?? known.requestIntervalSeconds,
  })
}

/** buildContext walks the log once and derives everything the questions need. It takes already-parsed
 * entries rather than text so the same derivation serves a fetched log and a pasted one. */
export function buildContext(
  entries: LogEntry[],
  { label = "log" }: { label?: string } = {},
): Context {
  // Which turn an entry belongs to is the index's answer, not a cursor's.
  //
  // `turnSource === "field"` means the index placed every entry in a span, so each entry's own turn
  // number is authoritative and the spans tile the array with no gap or overlap. A cursor is the weaker
  // answer: tracking the turn on request entries alone leaves everything between two requests inheriting
  // whatever the last one set.
  //
  // Two weaker cases remain, and neither can be answered by a map:
  //
  //   Mixed - some entries carry a turn and some do not. The index will not place those, but the field
  //   is still the best evidence there is, so the cursor behaviour is kept for them.
  //
  //   None - no entry carries a turn at all. Boundaries come from predictions instead, exactly one
  //   closing each turn. Without this every entry collapses onto turn 0 and the per-turn
  //   questions pass trivially.
  const indexedTurns = turnsAreStated(entries)
  const hasTurnField = indexedTurns || entries.some((entry) => "turn" in entry)

  const context: Context = {
    label,
    model: null,
    player: null,
    apis: new Set(),
    reasoningEfforts: new Set(),
    rawSetupByTurn: new Map(),
    replayByTurn: turnReports<Replay>(),
    output: {
      responses: 0, promptTokens: null, completionTokens: null, reasoningTokens: null,
      cachedPromptTokens: null, finishReasons: new Map(),
    },
    exits: new Map(),
    visitStatusAfterTurn: turnReports<Map<CellKey, VisitStatus>>(),
    positions: [],
    timeline: [],
    predictions: [],
    replays: [],
    declaredTools: new Set(),
    toolCalls: [],
    turnTools: new Map(),
    turnsWithPrediction: new Set(),
    speedReadings: [],
    outcomes: [],
    duplicatesAfterWarning: 0,
    hallucinated: 0,
    emptyResponses: 0,
    unparseableResponses: 0,
    endpointFailures: 0,
    agentDisablings: 0,
    harnessFailures: 0,
    tokenExhaustions: 0,
  }

  let currentTurn = 0
  let lastReplayKey = null

  const noteTool = (name: string): void => {
    const tools = context.turnTools.get(currentTurn) ?? new Set<string>()
    tools.add(name)
    context.turnTools.set(currentTurn, tools)
  }

  for (const entry of entries) {
    const details = asRecord(entry.details)

    // Read from the index's placement of this entry, so a tool result or an outcome is attributed to
    // the turn it was actually written in rather than to whichever request happened to precede it.
    if (indexedTurns && typeof entry.turn === "number") {
      currentTurn = entry.turn
    }

    if (entry.payload === LOG_EVENTS.request) {
      if (!indexedTurns && hasTurnField && typeof entry.turn === "number") {
        currentTurn = entry.turn
      }

      // Read from the request rather than the response: the provider and the effort are what Tapoo
      // asked for, and a request that never came back still records what was asked.
      if (typeof details.api === "string" && details.api) context.apis.add(details.api)
      if (typeof details.reasoning === "string" && details.reasoning) {
        context.reasoningEfforts.add(details.reasoning)
      }

      // The same facts kept per turn, which is what lets a seat be told from a seat. A round-wide set
      // answers "which providers appeared in this file" - useful - but cannot answer "what was seat 2
      // running", and a two-seat round needs the second question answered.
      //
      // Only the request's own flat fields. The `agent` record - {seatId, playerName, model, enabled} -
      // is deliberately not read as a fallback here: in every log to hand it appears on the round-end
      // entry and nowhere else, where it names whoever made the final dash rather than whoever played
      // this turn. In a two-seat round those are different agents, so borrowing it would report the
      // finisher's seat and model on every turn, including the turns the other seat played. The
      // round-end record has its own reader, in agentsFromRound, which attributes it to that one seat.
      noteSetup(context, currentTurn, {
        seatId: numberOrNull(details.seatId),
        model: textOrNull(details.model),
        echoBackReasoning: booleanOrNull(details.echoBackReasoning),
        requestIntervalSeconds: numberOrNull(details.requestIntervalSeconds),
        api: textOrNull(details.api),
        endpoint: textOrNull(details.endpoint),
        reasoning: textOrNull(details.reasoning),
      })

      for (const tool of asArray(details.tools).map(asRecord)) {
        // Logs record tools flat as { name, description }; the wire format nests them under
        // `function`. Accepting either keeps declaredTools populated - an empty set would make every
        // legitimate call look hallucinated.
        const name = tool.name ?? asRecord(tool.function).name
        if (typeof name === "string" && name) {
          context.declaredTools.add(name)
        }
      }

      for (const message of asArray(details.messages).map(asRecord)) {
        if (message.role !== "tool") {
          continue
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(typeof message.content === "string" ? message.content : "")
        } catch {
          continue
        }
        if (!parsed || typeof parsed !== "object") {
          continue
        }
        const payload = parsed as Record<string, unknown>

        if ("filteredTraversalHistory" in payload) {
          noteTool("get_maze_structure")
          // Built for this payload, then handed to the store, which is what knows the turn it covers. A
          // turn can carry more than one tool message, so the store merges rather than overwrites.
          const statuses = new Map<CellKey, VisitStatus>()

          // Guarded as an array: the key being present does not make the value iterable, and a non-list
          // here throws straight out of the report.
          for (const record of asArray(payload.filteredTraversalHistory).map(asRecord)) {
            const cell = cellKeyFromLogged(record.cell)
            if (cell) {
              context.exits.set(cell, openMovesFromLogged(record.openMoves))

              // Resolved through the move, because the status belongs to the cell the move reaches -
              // never to the cell whose entry carries it.
              for (const [move, status] of statusesFromLogged(record.openMoves)) {
                statuses.set(stepFrom(cell, move), status)
              }
            }
          }

          if (statuses.size > 0) {
            context.visitStatusAfterTurn.record(currentTurn, statuses, (existing, incoming) => {
              for (const [cell, status] of incoming) existing.set(cell, status)
              return existing
            })
          }
        }

        if ("currentCell" in payload) {
          noteTool("get_maze_structure")
          const cell = cellKeyFromLogged(payload.currentCell)
          if (cell) {
            // Consecutive identical readings are one arrival, not several.
            if (context.positions.at(-1) !== cell) {
              context.positions.push(cell)
              context.timeline.push({ kind: "position", cell })
            }
          }
        }

        if ("suggestedMovesPerTurn" in payload) {
          noteTool("get_prediction_rules")
          context.speedReadings.push([
            Number(payload.playerUniqueCellsVisited ?? 0),
            Number(payload.decayUnitsCharged ?? 0),
          ])
        }

        if ("lastMoveStatus" in payload) {
          noteTool("get_last_prediction_outcome")

          // Keyed by the turn that read it, not by the moves it describes.
          //
          // settlePredictions keys the same payload by the moves it names, and a move list is not unique
          // to a turn: in a real 464-turn log, 502 readings collapse onto 86 distinct sequences, 30 of
          // which were seen with different lastAppliedMoveIndex values. Keyed that way here too, last
          // write would win and 63 turns would hold another turn's path, applied count and refused move.
          //
          // The first reading of a turn is kept, not the last. A turn usually re-reads the same result
          // on each of its requests, but not always: when a request fails mid-turn - a provider 402
          // that disabled the agent, in the log this rule comes from - the turn runs again and the tool
          // now answers about *its own* failed attempt, "empty-prediction" charged nothing. Recorded
          // last, that answer replaces the previous turn's real result and its charge disappears from
          // the strip. Recorded first, the reading that describes turn N - 1 is the one that survives,
          // and a turn that genuinely made no prediction is still reported by the turn after it.
          context.replayByTurn.record(currentTurn, payload, (existing) => existing)

          if (payload.lastMoveStatus !== null) {
            const key = JSON.stringify([
              payload.lastMoveStatus,
              payload.lastSubmittedMoves,
              payload.lastAppliedMoveIndex,
              payload.chargedMovesCount,
            ])
            // The same result is re-read on every request of a turn; only transitions are new.
            if (key !== lastReplayKey) {
              lastReplayKey = key
              context.replays.push(payload)
            }
          }
        }
      }

      continue
    }

    if (entry.payload === LOG_EVENTS.response) {
      const body = asRecord(details.payload)
      context.model = typeof body.model === "string" ? body.model : context.model
      // The provider's echo, recorded as its own field rather than as the model. The two differ -
      // "gemma4:cloud" configured, "gemma4" answered - because an echo trims the ":provider" suffix
      // saying where the model was served from, whoever serves it: Hugging Face answers
      // "moonshotai/Kimi-K3" for "moonshotai/Kimi-K3:baseten". The declared name is the fuller one and
      // the one to report; merging them would read as a seat that ran two models.
      if (typeof body.model === "string" && body.model) {
        noteSetup(context, currentTurn, {echoedModel: body.model})
      }

      // Counted before the branches below, every one of which can skip the rest of this response. A
      // response with no usable message still cost tokens and still stopped for a reason, and a
      // summary that dropped those would understate what the model actually did.
      const usage = responseUsage(body)
      const totals = context.output
      totals.responses += 1
      for (const field of ["promptTokens", "completionTokens", "reasoningTokens", "cachedPromptTokens"] as const) {
        const reported = usage[field]
        if (reported !== null) totals[field] = (totals[field] ?? 0) + reported
      }
      if (usage.finishReason !== null) {
        totals.finishReasons.set(usage.finishReason, (totals.finishReasons.get(usage.finishReason) ?? 0) + 1)
      }

      const message = assistantMessage(body)
      if (!message) {
        context.emptyResponses += 1
        continue
      }

      // Tool names arrive already normalized: Ollama and OpenAI list them under tool_calls, Anthropic
      // as tool_use content blocks, and the contract reads all three the same way.
      if (message.toolNames.length > 0) {
        context.toolCalls.push(...message.toolNames)
        continue
      }

      const content = message.content
      if (content === null || !content.trim()) {
        context.emptyResponses += 1
        continue
      }

      const prediction = parseTurnPrediction(content)
      if (!prediction) {
        context.unparseableResponses += 1
        continue
      }

      const record = { ...prediction, turn: currentTurn }
      context.predictions.push(record)
      context.turnsWithPrediction.add(currentTurn)
      context.timeline.push({ kind: "prediction", record })
      // Only the no-turn-field log advances a cursor; an indexed one already knows.
      if (!hasTurnField) {
        currentTurn += 1
      }

      continue
    }

    if (entry.payload === LOG_EVENTS.duplicateToolWarningIgnored) {
      // A warned-mode request only shows the harness issued a warning. Repeating the call after it
      // is what the model did wrong, and this event is the only proof of that.
      context.duplicatesAfterWarning += 1
    } else if (entry.payload === LOG_EVENTS.hallucinatedTool) {
      context.hallucinated += 1
    } else if (entry.payload === LOG_EVENTS.tokenCapExhausted) {
      context.tokenExhaustions += 1
    } else if (
      entry.payload === LOG_EVENTS.providerHttpFailure ||
      entry.payload === LOG_EVENTS.requestFailed
    ) {
      // Scoped to the agent's own endpoint. Failures inside Tapoo's tool handlers also disable the
      // agent but are Tapoo's fault, so they are deliberately not counted here.
      context.endpointFailures += 1
    } else if (
      entry.payload === LOG_EVENTS.unsupportedProvider ||
      entry.payload === LOG_EVENTS.toolServiceFailure
    ) {
      // Not the model's and not the network's: a provider the app never dispatched to, and a tool handler
      // of Tapoo's that threw. This is the count the endpointFailures comment above defers.
      context.harnessFailures += 1
    } else if (entry.payload === LOG_EVENTS.agentDisabled) {
      // Counted apart from the failure that caused it. A request can fail and be retried; this is the
      // point the agent stopped playing, so it bounds what the rest of the round can be read to mean.
      context.agentDisablings += 1
    } else if (entry.payload === LOG_EVENTS.levelWon || entry.payload === LOG_EVENTS.levelLost) {
      const outcome = details as Outcome
      context.outcomes.push(outcome)
      context.player = outcome.agent?.playerName ?? context.player
      if (outcome.lastActionResult?.lastMoveStatus) {
        context.replays.push(outcome.lastActionResult)
      }
    }
  }

  settlePredictions(context)
  return context
}

// settlePredictions fills in what each prediction turned out to be: the cell it started from, and how
// many of its moves landed. A prediction is parsed the moment a response arrives, but neither fact is
// knowable then - both are settled later, by what the log went on to say.
//
// Two channels, because neither alone is enough: replay results are absent for a model that never calls
// get_last_prediction_outcome, and position triangulation is blind whenever a turn is not bracketed by
// two cell readings. What stays unsettled is left null - a figure the log did not state, which is not
// the same as a zero.
function settlePredictions(context: Context): void {
  // Keyed the way a prediction is read: the prefix the maze can apply, and how many commands were sent.
  //
  // Both sides have to be narrowed the same way or the join silently misses. A prediction holding a
  // command the maze cannot read keeps only its prefix, so keying the replay by its raw list would
  // never match it - and the turn would fall through to triangulation with a perfectly good answer
  // sitting in the log. The count travels with the prefix because a prefix is not an identity: two
  // predictions sharing one differ in what they asked for.
  const applies = new Map<string, number>()
  const keyOf = (moves: readonly Move[], submitted: number): string => JSON.stringify([moves, submitted])

  for (const replay of context.replays) {
    // Two different producers push into replays, so the field is only trusted to be a list of strings
    // once it has been checked here.
    const submitted = asArray(replay.lastSubmittedMoves).filter((move): move is string => typeof move === "string")
    if (submitted.length === 0) {
      continue
    }

    const applicable: Move[] = []
    for (const move of submitted) {
      if (!isMove(move)) break
      applicable.push(move)
    }

    const index = replay.lastAppliedMoveIndex
    applies.set(keyOf(applicable, submitted.length), typeof index === "number" ? index + 1 : 0)
  }

  context.timeline.forEach((event, position) => {
    if (event.kind !== "prediction") {
      return
    }

    const { record } = event
    const before = findCell(context.timeline, position, -1)
    const after = findCell(context.timeline, position, 1)
    record.before = before

    let applied: number | null | undefined = applies.get(keyOf(record.moves, record.submittedCount))
    if (applied === undefined && before && after) {
      // Position unchanged proves the very first move failed; otherwise the prefix that lands on the
      // observed cell is what applied.
      applied = before === after ? 0 : null
      let cell: CellKey = before
      // Over the applicable prefix: parseTurnPrediction already ended it at the first command the maze has
      // no move for, which is where a walk has to stop anyway.
      for (const [step, move] of record.moves.entries()) {
        cell = stepFrom(cell, move)
        if (cell === after) {
          applied = step + 1
          break
        }
      }
    }

    record.applied = applied ?? null
  })
}

function findCell(timeline: Context["timeline"], from: number, direction: 1 | -1): CellKey | null {
  for (let i = from + direction; i >= 0 && i < timeline.length; i += direction) {
    const event = timeline[i]
    if (event?.kind === "position") {
      return event.cell
    }
  }

  return null
}
