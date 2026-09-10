// Tapoo Agentic Behavior rubric engine.
//
// Answers the canonical fact questions below against the entries of a downloaded agent-api log and
// returns both definitions and answers as data. It does no IO and prints nothing: the Tapoo Oracle
// app renders its views from this object. Keeping definitions beside their evaluators prevents the
// report from describing a different question than the engine actually answered.
//
// Like log-contract.ts, this file must stay free of node: imports so it can be bundled for the
// browser.
//
// Every question returns strictly true or false, never null. A question quantified over an empty set
// answers false rather than being vacuously true: "all of none complied" is not compliance, and
// reporting it as such would credit a model that never submitted a prediction. A false always means
// "not observed in this sample", never "incapable" - that distinction lives in how results are read,
// which is why no third answer value exists to carry it.
//
// Adding a question means writing a function and listing it in CAPABILITIES or VIOLATIONS. Every
// shared derivation happens once, in buildContext.

import {
  DECLARED_TOOLS,
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
  GroupKind,
  LogEntry,
  Move,
  Outcome,
  Submission,
  RubricGroup,
  RawTurnSetup,
} from "./types"

// --- Reading a log entry ---

/** parsePrediction recovers the moves array a model submitted, mirroring the three tiers
 * frontend/app/agent/protocol.ts accepts: bare JSON, a fenced block, or a trailing object after
 * prose. The tier matters on its own - it is what C1.Q1 scores - so it is returned, not discarded. */
export function parsePrediction(content: unknown): Omit<Submission, "turn"> | null {
  if (typeof content !== "string" || !content.trim()) {
    return null
  }

  const text = content.trim()
  const candidates: Array<[string, Submission["tier"]]> = [[text, 1]]

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
      // into the rubric as if its shape were known. `moves` stays unknown[] on purpose - what the
      // model sent is exactly the thing the questions are asking about.
      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === "object" && "moves" in parsed) {
        // A `moves` that is not a list is a malformed prediction, and it becomes an empty one rather
        // than a one-move one: wrapping it would let `{"moves": "MoveUp"}` be scored as a valid single
        // move, which is the opposite of what the questions are asking. The key is still recorded in
        // `keys`, so the difference between "no moves key" and "a moves key holding junk" survives.
        //
        // Returning whatever the model sent instead lets a string reach `.every` in the rubric, which is
        // not a method on a string: one malformed response then throws out of buildReport and takes the
        // whole page render with it.
        const moves: unknown = parsed.moves
        return {moves: Array.isArray(moves) ? moves : [], tier, keys: Object.keys(parsed)}
      }
    } catch {
      // Candidate was not JSON; fall through to the next tier.
    }
  }

  return null
}

// --- Building the context ---

const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null)
const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null

/** Merges what one entry said about a turn's seat into what is already known about it.
 *
 * Merged rather than overwritten because the facts arrive on two entries - the request carries the seat,
 * the model it was configured with, the provider and the effort; the response carries the provider's
 * echo of that model - and a turn is one seat's, so neither should erase the other. Only fields with
 * something to say are written. */
function noteSetup(context: Context, turn: number, seen: Partial<RawTurnSetup>): void {
  const known = context.rawSetupByTurn.get(turn) ?? {
    seatId: null, model: null, echoedModel: null, api: null, endpoint: null, reasoning: null,
  }
  context.rawSetupByTurn.set(turn, {
    seatId: seen.seatId ?? known.seatId,
    model: seen.model ?? known.model,
    echoedModel: seen.echoedModel ?? known.echoedModel,
    api: seen.api ?? known.api,
    endpoint: seen.endpoint ?? known.endpoint,
    reasoning: seen.reasoning ?? known.reasoning,
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
    submissions: [],
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
          // annotateApplied keys the same payload by JSON.stringify of its move list, and a move list
          // is not unique to a turn: in a real 464-turn log, 502 readings collapse onto 86 distinct
          // sequences, 30 of which were seen with different lastAppliedMoveIndex values. Last write
          // wins, so 63 turns ended up with another turn's path, applied count and refused move.
          //
          // A turn re-reads the same result on each of its requests, so writing it repeatedly is
          // idempotent - no turn was ever observed reporting two different values.
          context.replayByTurn.record(currentTurn, payload)

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

      const prediction = parsePrediction(content)
      if (!prediction) {
        context.unparseableResponses += 1
        continue
      }

      const record = { ...prediction, turn: currentTurn }
      context.submissions.push(record)
      context.turnsWithPrediction.add(currentTurn)
      context.timeline.push({ kind: "submission", record })
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

  annotateApplied(context)
  return context
}

// annotateApplied resolves how many of each submission's moves landed, combining every channel that
// can prove it. Neither alone is enough: replay results are absent for a model that never calls
// get_last_prediction_outcome, and position triangulation is blind whenever a turn is not bracketed by two
// readings.
function annotateApplied(context: Context): void {
  const byMoves = new Map<string, number>()
  for (const replay of context.replays) {
    // Two different producers push into replays, so the field is only trusted to be a list of strings
    // once it has been checked here.
    const submitted = asArray(replay.lastSubmittedMoves)
      .filter((move): move is string => typeof move === "string")
      .map((move) => move.split(":").at(-1))
    if (submitted.length > 0) {
      const index = replay.lastAppliedMoveIndex
      byMoves.set(JSON.stringify(submitted), typeof index === "number" ? index + 1 : 0)
    }
  }

  context.timeline.forEach((event, position) => {
    if (event.kind !== "submission") {
      return
    }

    const { record } = event
    const before = findCell(context.timeline, position, -1)
    const after = findCell(context.timeline, position, 1)
    record.before = before

    let applied: number | null | undefined = byMoves.get(JSON.stringify(record.moves))
    if (applied === undefined && before && after) {
      // Position unchanged proves the very first move failed; otherwise the prefix that lands on the
      // observed cell is what applied.
      applied = before === after ? 0 : null
      let cell: CellKey = before
      for (const [step, move] of record.moves.entries()) {
        // A move the maze cannot apply ends the walk. The submitted array is a model's JSON, so it can
        // name anything at all.
        if (!isMove(move)) {
          break
        }
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

// --- Shared predicates ---

const exitsOf = (context: Context, cell: CellKey | null | undefined): Set<Move> | null =>
  (cell === null || cell === undefined ? null : context.exits.get(cell)) ?? null

const isCorridor = (context: Context, cell: CellKey | null | undefined): boolean =>
  exitsOf(context, cell)?.size === 2

const fullyApplied = (record: Submission): boolean => record.applied === record.moves.length

// inConfirmedCorridorRun reports whether at least two forced steps ahead are already known safe:
// both the current cell and the one the move leads into are confirmed two-exit corridors. That is
// the shape where batching costs nothing extra and single-stepping wastes a free decay unit.
function inConfirmedCorridorRun(context: Context, cell: CellKey, move: unknown): boolean {
  if (!isMove(move) || !isCorridor(context, cell) || !exitsOf(context, cell)?.has(move)) {
    return false
  }

  return isCorridor(context, stepFrom(cell, move))
}


// --- Capability questions ---

// C1. INSTRUCTION ADHERENCE   scope: responses a moves array was extracted from
function instructionAdherence(context: Context): Record<string, boolean> {
  const submissions = context.submissions
  if (submissions.length === 0) {
    return { Q1: false, Q2: false, Q3: false }
  }

  return {
    // Q1. Are all prediction responses bare JSON, no fences or prose?
    Q1: submissions.every((entry) => entry.tier === 1),
    // Q2. Do all carry no fields beyond "moves"?
    Q2: submissions.every((entry) => entry.keys.length === 1 && entry.keys[0] === "moves"),
    // Q3. Are all move commands one of MoveUp / MoveDown / MoveLeft / MoveRight?
    Q3: submissions.every((entry) => entry.moves.every((move) => isMove(move))),
  }
}

// C2. VALID ACTION DELIVERY
// Q1. Did the agent produce at least one valid move (a successfully applied move)?
function validActionDelivery(context: Context): Record<string, boolean> {
  return { Q1: context.submissions.some((entry) => (entry.applied ?? 0) > 0) }
}

const contextAcquisitionQuestions = Object.fromEntries(
  DECLARED_TOOLS.map((tool, index) => [
    `Q${index + 1}`,
    {
      get_maze_structure: "Did the agent obtain the maze structure on every prediction turn?",
      get_prediction_rules: "Did the agent obtain the prediction rules on every prediction turn?",
      get_last_prediction_outcome: "Did the agent obtain the last prediction outcome on every prediction turn?",
    }[tool] ?? `Did the agent obtain ${tool} on every prediction turn?`,
  ]),
)

// C3. CONTEXT ACQUISITION - each question asks whether one payload was extracted on
// every prediction turn.
function contextAcquisition(context: Context): Record<string, boolean> {
  const turns = [...context.turnsWithPrediction]
  const needed = DECLARED_TOOLS

  return Object.fromEntries(
    needed.map((tool, index) => [
      `Q${index + 1}`,
      turns.length > 0 && turns.every((turn) => context.turnTools.get(turn)?.has(tool) === true),
    ]),
  )
}

// C4. STATE AWARENESS
// Q1. Was each first submitted move consistent with confirmed open exits when known?
function stateAwareness(context: Context): Record<string, boolean> {
  const checkable = context.submissions.filter((entry) => entry.before && exitsOf(context, entry.before))
  if (checkable.length === 0) {
    return { Q1: false }
  }

  return {
    Q1: checkable.every((entry) => {
      const known = exitsOf(context, entry.before)
      const first = entry.moves[0]
      // isMove rather than a string check: the exits set holds Moves, so a name the maze cannot apply
      // could never be a member of it.
      return known !== null && isMove(first) && known.has(first)
    }),
  }
}

// C5. RESOURCE EFFICIENCY
// Q1. At round end, is traversal speed (playerUniqueCellsVisited per decayUnitsCharged)
//     at least 1.0000 (Navigator)?
function resourceEfficiency(context: Context): Record<string, boolean> {
  // The rubric asks this "at round end", and requires the winning turn's own progress and decay to be
  // included. speedReadings holds per-request tool readings, so its last entry is the state *before*
  // the final turn resolved - on a won round that undercounts both terms and answers no for an agent
  // that finished at exactly 1.0000. The round-end entry carries the settled totals, so it is preferred
  // and the last reading is used only when no round ended in this sample.
  //
  // A round-end entry is only preferable when it actually carries both totals: older logs record the
  // outcome without them, and reading those as a zero pair would answer no for a round whose per-turn
  // readings prove otherwise. Absent totals fall through to the last reading rather than to a verdict.
  const outcome = context.outcomes.at(-1)
  const visited = outcome?.playerUniqueCellsVisited
  const charged = outcome?.decayUnitsCharged

  // Narrowed to a pair here rather than checked again below: a check after the fallback would be a
  // branch nothing can reach, since a settled outcome states both numbers and a speed reading is
  // already a pair.
  const settled: readonly [number, number] | null =
    Number.isFinite(visited) && Number.isFinite(charged) ? [visited as number, charged as number] : null

  const reading = settled ?? context.speedReadings.at(-1)
  if (!reading) {
    return { Q1: false }
  }

  const [cells, decay] = reading
  return { Q1: decay > 0 && cells / decay >= 1.0000 }
}

// C6. MULTI-STEP EXECUTION
function multiStepExecution(context: Context): Record<string, boolean> {
  const batches = context.submissions.filter((entry) => entry.moves.length >= 2)
  return {
    // Q1. Did the agent make any batched (2+ move) prediction?
    Q1: batches.length > 0,
    // Q2. Did any batched prediction fully apply?
    Q2: batches.some(fullyApplied),
  }
}

// C7. STRUCTURAL REASONING
function structuralReasoning(context: Context): Record<string, boolean> {
  const batches = context.submissions.filter((entry) => entry.moves.length >= 2)
  const trailblazerWin = context.outcomes.some(
    (outcome) => outcome.outcome === "won" && Number(outcome.traversalSpeed) > 1.0000,
  )
  return {
    // Q1. Was there a batch through confirmed branchless structure where every move applied?
    Q1: batches.some(
      (entry) =>
        fullyApplied(entry) &&
        entry.before &&
        inConfirmedCorridorRun(context, entry.before, entry.moves[0]),
    ),
    // Q2. Did the sampled level end in a Trailblazer-speed win?
    Q2: trailblazerWin,
  }
}

// C8. ADAPTIVE RECOVERY
// Q1. Was there a failed turn where the following turn's prediction had its first
//     two consecutive moves applied?
//
// A single applied move proves nothing here: the current cell's open exits are handed to the model on
// every tool call, so repeating one back is transcription. The second consecutive move is the first
// that requires reasoning about a cell it was not given.
function adaptiveRecovery(context: Context): Record<string, boolean> {
  const submissions = context.submissions
  for (const [index, failed] of submissions.entries()) {
    const next = submissions[index + 1]
    if (!next || typeof failed.applied !== "number" || typeof next.applied !== "number") {
      continue
    }

    if (failed.applied < failed.moves.length && next.applied >= 2) {
      return { Q1: true }
    }
  }

  return { Q1: false }
}

// C9. TASK COMPLETION
// Q1. Did the agent reach the destination in any sampled round?
function taskCompletion(context: Context): Record<string, boolean> {
  return { Q1: context.outcomes.some((outcome) => outcome.outcome === "won") }
}


// --- Violation questions ---

// V1. HALLUCINATIONS
// Q1. Any tool call naming something outside the declared tools set?
function hallucinations(context: Context): Record<string, boolean> {
  const undeclared = context.toolCalls.some((name) => name && !context.declaredTools.has(name))
  return { Q1: undeclared || context.hallucinated > 0 }
}

// V2. OUTPUT CONTRACT FAILURE
function outputContractFailure(context: Context): Record<string, boolean> {
  return {
    // Q1. Any response with content but no extractable moves array?
    Q1: context.unparseableResponses > 0,
    // Q2. Any response carrying neither content nor tool calls, including one with
    //     no message object at all?
    Q2: context.emptyResponses > 0,
  }
}

// V3. WARNING DISREGARD
// Q1. Any duplicate tool call repeated after a warning?
function warningDisregard(context: Context): Record<string, boolean> {
  return { Q1: context.duplicatesAfterWarning > 0 }
}

// V4. AVAILABLE-CONTEXT DISREGARD
function availableContextDisregard(context: Context): Record<string, boolean> {
  // Q1. Any move submitted that was not among its cell's confirmed open exits
  //     (open exits clue disregarded)?
  return { Q1: context.submissions.some((entry) => {
    if (!entry.before) {
      return false
    }

    let cell = entry.before
    for (const move of entry.moves) {
      const known = exitsOf(context, cell)
      if (!known || cell === null || cell === undefined) {
        return false
      }
      // A move that is not among the cell's stated exits disregards the context - that is the question.
      // isMove is part of the same test rather than a separate branch after it: the exits set holds
      // Moves, so a name the maze cannot apply is not in it and is not something the cell offered.
      //
      // Which leaves no third case to handle: a cell cannot be recorded as offering a name the maze
      // cannot apply, because openMovesFromLogged drops it at the parse. Were one to reach here, the
      // agent would have used what it was told and nothing would have been disregarded.
      if (!isMove(move) || !known.has(move)) {
        return true
      }
      cell = stepFrom(cell, move)
    }

    return false
  }) }
}

// V5. RESOURCE WASTE
function resourceWaste(context: Context): Record<string, boolean> {
  // Q1. Was any known cell entered more times than its confirmed open-move count?
  //
  // Answered from Tapoo's own label wherever the log carries one. `oscillating` is defined as precisely
  // this question - visits above the cell's fixed open-exit count - so a cell that ever wore it is the
  // violation, stated by the producer rather than recomputed here.
  //
  // The derivation below it was under-reporting, in two ways that compound. It counted
  // `context.positions`, which records one cell per turn - so a turn applying three moves contributed
  // its final cell and the two it passed through were never counted at all. And it needed
  // `exitsOf`, which only knows cells that appeared in some filteredTraversalHistory, so any cell
  // without one was skipped by the `known !== null` guard rather than judged.
  //
  // The label has neither problem: Tapoo counts every entry, against the fixed exit count, for every
  // cell - and every visited cell is named by some window, so the harvest is complete for exactly the
  // cells this question is about.
  const oscillated = [...context.visitStatusAfterTurn.values()].some((cells) =>
    [...cells.values()].some((status) => status === "oscillating"),
  )

  // A spanning tree lets a complete depth-first exploration touch a cell once per exit - in and back
  // out of each branch - so exceeding the exit count, not matching it, is what cannot be justified.
  //
  // Kept for a log that carries no statuses at all - an older export, or a round where the agent never
  // called get_maze_structure. Unchanged, including its blind spots: it is what this question answered
  // before, and a log that cannot reach the label should get the same answer it always did rather than
  // a differently-wrong one. One provenance per log, never a blend of the two.
  const derivedExcessVisits = (): boolean => {
    const arrivals = new Map<CellKey, number>()
    for (const cell of context.positions) {
      arrivals.set(cell, (arrivals.get(cell) ?? 0) + 1)
    }

    return [...arrivals].some(([cell, count]) => {
      const known = exitsOf(context, cell)
      return known !== null && count > known.size
    })
  }

  const excessVisits = context.visitStatusAfterTurn.size > 0 ? oscillated : derivedExcessVisits()

  // Q3. Any single-move prediction from inside a confirmed branchless corridor
  //     (corridor structure disregarded)?
  const declinedFreeBatch = context.submissions.some(
    (entry) =>
      entry.moves.length === 1 &&
      entry.before &&
      inConfirmedCorridorRun(context, entry.before, entry.moves[0]),
  )

  return { Q1: excessVisits, Q2: declinedFreeBatch, Q3: context.tokenExhaustions > 0 }
}

// V6. FAILED-STATE REPETITION
// Q1. Any prediction repeating verbatim a moves array already proven invalid from
//     the same cell?
function failedStateRepetition(context: Context): Record<string, boolean> {
  const failed = new Set()
  for (const entry of context.submissions) {
    if (!entry.before || entry.applied === null) {
      continue
    }

    const key = JSON.stringify([entry.before, entry.moves])
    if (failed.has(key)) {
      return { Q1: true }
    }
    if (entry.applied === 0) {
      failed.add(key)
    }
  }

  return { Q1: false }
}

// --- Groups ---

/** The capability half of the rubric, in the order the report presents it.
 *
 * Each entry is the whole of a group: its id, the questions in the reader's words, and the function
 * that answers them. Kept together deliberately - a question moved away from its evaluator is how a
 * report comes to describe one thing and answer another.
 *
 * A capability's verdict is the conjunction of its questions, so adding a question can only ever lower
 * a verdict, never raise one. A group that answers NO means the behavior was not observed in this
 * sample - never that the model is incapable of it. */
export const CAPABILITIES: RubricGroup[] = [
  {
    id: "C1",
    label: "INSTRUCTION ADHERENCE",
    questions: {
      Q1: "Were all extracted prediction responses bare JSON with no Markdown fences or prose?",
      Q2: "Did every prediction object contain exactly one top-level key named moves?",
      Q3: "Were all submitted commands MoveUp, MoveDown, MoveLeft, or MoveRight?",
    },
    evaluate: instructionAdherence,
  },
  {
    id: "C2",
    label: "VALID ACTION DELIVERY",
    questions: {Q1: "Did the agent produce at least one successfully applied move?"},
    evaluate: validActionDelivery,
  },
  {
    id: "C3",
    label: "CONTEXT ACQUISITION",
    questions: contextAcquisitionQuestions,
    evaluate: contextAcquisition,
  },
  {
    id: "C4",
    label: "STATE AWARENESS",
    questions: {
      Q1: "Where the current cell's exits were known, was every first submitted move a confirmed open move?",
    },
    evaluate: stateAwareness,
  },
  {
    id: "C5",
    label: "RESOURCE EFFICIENCY",
    questions: {
      Q1: "Was the final recorded traversal speed at least 1.0000 unique cells per charged decay unit?",
    },
    evaluate: resourceEfficiency,
  },
  {
    id: "C6",
    label: "MULTI-STEP EXECUTION",
    questions: {
      Q1: "Did the agent submit at least one prediction containing two or more moves?",
      Q2: "Did every move apply in at least one prediction containing two or more moves?",
    },
    evaluate: multiStepExecution,
  },
  {
    id: "C7",
    label: "STRUCTURAL REASONING",
    questions: {
      Q1: "Did a fully applied multi-move prediction start through two confirmed consecutive corridor cells?",
      Q2: "Did the sampled level end in a win with traversal speed above 1.0000?",
    },
    evaluate: structuralReasoning,
  },
  {
    id: "C8",
    label: "ADAPTIVE RECOVERY",
    questions: {
      Q1: "After a partially or wholly failed prediction, did the next prediction apply at least two consecutive moves?",
    },
    evaluate: adaptiveRecovery,
  },
  {
    id: "C9",
    label: "TASK COMPLETION",
    questions: {Q1: "Did the agent reach the destination in any sampled round?"},
    evaluate: taskCompletion,
  },
]

/** The violation half, in the same shape and never merged with the half above.
 *
 * The rule inverts: a violation's verdict is the *disjunction* of its questions, because one confirmed
 * breach is a breach. That inversion is also why the two lists cannot be concatenated and counted -
 * they answer to opposite aggregation rules, and the rubric forbids collapsing them into one score. */
export const VIOLATIONS: RubricGroup[] = [
  {
    id: "V1",
    label: "TOOL HALLUCINATION",
    questions: {Q1: "Did the agent call a tool outside the declared tool set?"},
    evaluate: hallucinations,
  },
  {
    id: "V2",
    label: "OUTPUT CONTRACT FAILURE",
    questions: {
      Q1: "Did any final response contain content from which no moves prediction could be extracted?",
      Q2: "Did any final response contain neither content nor tool calls, including no message object?",
    },
    evaluate: outputContractFailure,
  },
  {
    id: "V3",
    label: "WARNING DISREGARD",
    questions: {Q1: "Did the agent repeat a duplicate tool call after receiving a warning?"},
    evaluate: warningDisregard,
  },
  {
    id: "V4",
    label: "AVAILABLE-CONTEXT DISREGARD",
    questions: {Q1: "Did any submitted move contradict the confirmed open moves of a known cell?"},
    evaluate: availableContextDisregard,
  },
  {
    id: "V5",
    label: "RESOURCE WASTE",
    questions: {
      Q1: "Was any known cell entered more times than its confirmed open-move count?",
      Q2: "Did the agent single-step where two consecutive branchless corridor cells were already known?",
      Q3: "Did any response exhaust the configured completion-token cap?",
    },
    evaluate: resourceWaste,
  },
  {
    id: "V6",
    label: "FAILED-STATE REPETITION",
    questions: {Q1: "From the same cell, did the agent repeat a moves array already proven wholly invalid there?"},
    evaluate: failedStateRepetition,
  },
]

/** aggregate turns a group's per-question answers into its verdict: a capability needs every question
 * answered yes; a violation needs only one. The assertion is not
 * defensive noise - a question returning anything but a boolean would silently skew both rules. */
export function aggregate(answers: Record<string, boolean>, kind: GroupKind): boolean {
  const values = Object.values(answers)
  if (!values.every((value) => value === true || value === false)) {
    throw new Error(`non-boolean answer: ${JSON.stringify(answers)}`)
  }

  return kind === "capability" ? values.every(Boolean) : values.some(Boolean)
}
