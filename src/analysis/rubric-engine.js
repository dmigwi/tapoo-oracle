// Tapoo Agentic Behavior rubric engine.
//
// Answers the canonical fact questions below against the entries of a downloaded agent-api log and
// returns both definitions and answers as data. It does no IO and prints nothing: the Tapoo Oracle
// app renders its views from this object. Keeping definitions beside their evaluators prevents the
// report from describing a different question than the engine actually answered.
//
// Like log-contract.mjs, this file must stay free of node: imports so it can be bundled for the
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
  MOVES,
  cellKey,
  classifyTraversalSpeed,
  stepFrom,
} from "../contracts/log-contract.js"
import { cellFromGridPoint } from "../contracts/maze.js"

// --- Reading a log entry ---

// parsePrediction recovers the moves array a model submitted, mirroring the three tiers
// frontend/app/agent/protocol.ts accepts: bare JSON, a fenced block, or a trailing object after
// prose. The tier matters on its own - it is what C1.Q1 scores - so it is returned, not discarded.
function parsePrediction(content) {
  if (!content?.trim()) {
    return null
  }

  const text = content.trim()
  const candidates = [[text, 1]]

  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenced) {
    candidates.push([fenced[1].trim(), 2])
  }

  const embedded = text.lastIndexOf("{")
  if (embedded !== -1) {
    candidates.push([text.slice(embedded).trim(), 3])
  }

  for (const [candidate, tier] of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && "moves" in parsed) {
        return { moves: parsed.moves, tier, keys: Object.keys(parsed) }
      }
    } catch {
      // Candidate was not JSON; fall through to the next tier.
    }
  }

  return null
}

// readCell accepts either shape a logged cell arrives in and returns its "row,col" key, or null.
//
// A downloaded log compacts every get_maze_structure result before writing it (compactLoggedToolResult
// in Tapoo's frontend/app/agent/protocol.ts), turning {row, col} into [row, col]. Only the uncompacted
// object form was read here originally, so against a real export every key became
// "undefined,undefined": context.exits collapsed to a single junk entry and context.positions held one
// junk cell. That did not fail loudly - it silently reduced C4, C7.Q1, V4 and V5 to verdicts about
// nothing, and V4 in particular then reported a confirmed violation against the model. Both shapes are
// accepted because a log may contain either, and neither is wrong.
function readCell(cell) {
  if (Array.isArray(cell)) {
    return cell.length === 2 ? cellKey(cell[0], cell[1]) : null
  }

  if (cell && typeof cell === "object" && typeof cell.row === "number" && typeof cell.col === "number") {
    return cellKey(cell.row, cell.col)
  }

  return null
}

// readOpenMoves returns the set of move names a cell's exits allow, from either logged shape: the
// uncompacted object keyed by move name, or the compacted [move, visitStatus] pairs. Reading the
// compacted form with Object.keys would yield array indices - "0", "1" - which match no move command,
// so every exit check silently failed.
function readOpenMoves(openMoves) {
  if (Array.isArray(openMoves)) {
    return new Set(openMoves.map((entry) => (Array.isArray(entry) ? entry[0] : entry)).filter(Boolean))
  }

  return new Set(Object.keys(openMoves ?? {}))
}

// --- Building the context ---

// buildContext walks the log once and derives everything the questions need. It takes already-parsed
// entries rather than a path so the same derivation serves a file on disk and a pasted payload.
export function buildContext(entries, { label = "log" } = {}) {

  // Logs written before the turn counter landed have no turn field, so turn boundaries are inferred
  // from predictions instead - exactly one closes each turn. Without this every entry collapses onto
  // turn 0 and the per-turn questions pass trivially.
  const hasTurnField = entries.some((entry) => "turn" in entry)

  const context = {
    label,
    model: null,
    player: null,
    exits: new Map(),
    positions: [],
    timeline: [],
    submissions: [],
    replays: [],
    declaredTools: new Set(),
    toolCalls: [],
    turnTools: new Map(),
    turnsWithPrediction: new Set(),
    speedReadings: [],
    suggested: null,
    outcomes: [],
    duplicatesAfterWarning: 0,
    hallucinated: 0,
    emptyResponses: 0,
    unparseableResponses: 0,
    endpointFailures: 0,
    tokenExhaustions: 0,
  }

  let currentTurn = 0
  let lastReplayKey = null

  const noteTool = (name) => {
    if (!context.turnTools.has(currentTurn)) {
      context.turnTools.set(currentTurn, new Set())
    }
    context.turnTools.get(currentTurn).add(name)
  }

  for (const entry of entries) {
    const details = entry.details ?? {}

    if (entry.payload === LOG_EVENTS.request) {
      if (hasTurnField) {
        currentTurn = entry.turn
      }

      for (const tool of details.tools ?? []) {
        // Logs record tools flat as { name, description }; the wire format nests them under
        // `function`. Accepting either keeps declaredTools populated - an empty set would make every
        // legitimate call look hallucinated.
        const name = tool.name ?? tool.function?.name
        if (name) {
          context.declaredTools.add(name)
        }
      }

      for (const message of details.messages ?? []) {
        if (message.role !== "tool") {
          continue
        }

        let payload
        try {
          payload = JSON.parse(message.content ?? "")
        } catch {
          continue
        }
        if (!payload || typeof payload !== "object") {
          continue
        }

        if ("filteredTraversalHistory" in payload) {
          noteTool("get_maze_structure")
          for (const record of payload.filteredTraversalHistory) {
            const cell = readCell(record.cell)
            if (cell) {
              context.exits.set(cell, readOpenMoves(record.openMoves))
            }
          }
        }

        if ("currentCell" in payload) {
          noteTool("get_maze_structure")
          const cell = readCell(payload.currentCell)
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
          context.suggested = payload.suggestedMovesPerTurn
          context.speedReadings.push([
            payload.playerUniqueCellsVisited ?? 0,
            payload.decayUnitsCharged ?? 0,
          ])
        }

        if ("lastMoveStatus" in payload) {
          noteTool("get_last_prediction_outcome")
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
      const body = details.payload ?? {}
      context.model = body.model ?? context.model

      const message = body.message
      if (!message) {
        context.emptyResponses += 1
        continue
      }

      const calls = message.tool_calls ?? []
      if (calls.length > 0) {
        context.toolCalls.push(...calls.map((call) => call.function?.name))
        continue
      }

      const content = message.content ?? ""
      if (!content.trim()) {
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
    } else if (entry.payload === LOG_EVENTS.levelWon || entry.payload === LOG_EVENTS.levelLost) {
      context.outcomes.push(details)
      context.player = details.agent?.playerName ?? context.player
      if (details.lastActionResult?.lastMoveStatus) {
        context.replays.push(details.lastActionResult)
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
function annotateApplied(context) {
  const byMoves = new Map()
  for (const replay of context.replays) {
    const submitted = (replay.lastSubmittedMoves ?? []).map((move) => move.split(":").at(-1))
    if (submitted.length > 0) {
      const index = replay.lastAppliedMoveIndex
      byMoves.set(JSON.stringify(submitted), index === null ? 0 : index + 1)
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

    let applied = byMoves.get(JSON.stringify(record.moves))
    if (applied === undefined && before && after) {
      // Position unchanged proves the very first move failed; otherwise the prefix that lands on the
      // observed cell is what applied.
      applied = before === after ? 0 : null
      let cell = before
      for (const [step, move] of record.moves.entries()) {
        if (!MOVES[move]) {
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

function findCell(timeline, from, direction) {
  for (let i = from + direction; i >= 0 && i < timeline.length; i += direction) {
    if (timeline[i].kind === "position") {
      return timeline[i].cell
    }
  }

  return null
}

// --- Shared predicates ---

const exitsOf = (context, cell) => context.exits.get(cell) ?? null

const isCorridor = (context, cell) => exitsOf(context, cell)?.size === 2

const fullyApplied = (record) => record.applied === record.moves.length

// inConfirmedCorridorRun reports whether at least two forced steps ahead are already known safe:
// both the current cell and the one the move leads into are confirmed two-exit corridors. That is
// the shape where batching costs nothing extra and single-stepping wastes a free decay unit.
function inConfirmedCorridorRun(context, cell, move) {
  if (!MOVES[move] || !isCorridor(context, cell) || !exitsOf(context, cell)?.has(move)) {
    return false
  }

  return isCorridor(context, stepFrom(cell, move))
}


// --- Capability questions ---

// C1. INSTRUCTION ADHERENCE   scope: responses a moves array was extracted from
function instructionAdherence(context) {
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
    Q3: submissions.every((entry) => entry.moves.every((move) => move in MOVES)),
  }
}

// C2. VALID ACTION DELIVERY
// Q1. Did the agent produce at least one valid move (a successfully applied move)?
function validActionDelivery(context) {
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
function contextAcquisition(context) {
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
function stateAwareness(context) {
  const checkable = context.submissions.filter((entry) => entry.before && exitsOf(context, entry.before))
  if (checkable.length === 0) {
    return { Q1: false }
  }

  return { Q1: checkable.every((entry) => exitsOf(context, entry.before).has(entry.moves[0])) }
}

// C5. RESOURCE EFFICIENCY
// Q1. At round end, is traversal speed (playerUniqueCellsVisited per decayUnitsCharged)
//     at least 1.0000 (Navigator)?
function resourceEfficiency(context) {
  // The rubric asks this "at round end", and requires the winning turn's own progress and decay to be
  // included. speedReadings holds per-request tool readings, so its last entry is the state *before*
  // the final turn resolved - on a won round that undercounts both terms and answers no for an agent
  // that finished at exactly 1.0000. The round-end entry carries the settled totals, so it is preferred
  // and the last reading is used only when no round ended in this sample.
  // A round-end entry is only preferable when it actually carries both totals: older logs record the
  // outcome without them, and reading those as a zero pair would answer no for a round whose per-turn
  // readings prove otherwise. Absent totals fall through to the last reading rather than to a verdict.
  const outcome = context.outcomes.at(-1)
  const settled = [outcome?.playerUniqueCellsVisited, outcome?.decayUnitsCharged]
  const reading = settled.every((value) => Number.isFinite(value))
    ? settled
    : context.speedReadings.at(-1)

  if (!reading) {
    return { Q1: false }
  }

  const [cells, decay] = reading
  return { Q1: decay > 0 && cells / decay >= 1.0000 }
}

// C6. MULTI-STEP EXECUTION
function multiStepExecution(context) {
  const batches = context.submissions.filter((entry) => entry.moves.length >= 2)
  return {
    // Q1. Did the agent make any batched (2+ move) prediction?
    Q1: batches.length > 0,
    // Q2. Did any batched prediction fully apply?
    Q2: batches.some(fullyApplied),
  }
}

// C7. STRUCTURAL REASONING
function structuralReasoning(context) {
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
function adaptiveRecovery(context) {
  const submissions = context.submissions
  for (const [index, failed] of submissions.entries()) {
    const next = submissions[index + 1]
    if (!next || failed.applied === null || next.applied === null) {
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
function taskCompletion(context) {
  return { Q1: context.outcomes.some((outcome) => outcome.outcome === "won") }
}


// --- Violation questions ---

// V1. HALLUCINATIONS
// Q1. Any tool call naming something outside the declared tools set?
function hallucinations(context) {
  const undeclared = context.toolCalls.some((name) => name && !context.declaredTools.has(name))
  return { Q1: undeclared || context.hallucinated > 0 }
}

// V2. OUTPUT CONTRACT FAILURE
function outputContractFailure(context) {
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
function warningDisregard(context) {
  return { Q1: context.duplicatesAfterWarning > 0 }
}

// V4. AVAILABLE-CONTEXT DISREGARD
function availableContextDisregard(context) {
  // Q1. Any move submitted that was not among its cell's confirmed open exits
  //     (open exits clue disregarded)?
  return { Q1: context.submissions.some((entry) => {
    if (!entry.before) {
      return false
    }

    let cell = entry.before
    for (const move of entry.moves) {
      const known = exitsOf(context, cell)
      if (!known) {
        return false
      }
      if (!known.has(move)) {
        return true
      }
      cell = stepFrom(cell, move)
    }

    return false
  }) }
}

// V5. RESOURCE WASTE
function resourceWaste(context) {
  // Q2. Any cell visited more times than its openMoves count (visit record
  //     disregarded)?
  const arrivals = new Map()
  for (const cell of context.positions) {
    arrivals.set(cell, (arrivals.get(cell) ?? 0) + 1)
  }

  // A spanning tree lets a complete depth-first exploration touch a cell once per exit - in and back
  // out of each branch - so exceeding the exit count, not matching it, is what cannot be justified.
  const excessVisits = [...arrivals].some(
    ([cell, count]) => exitsOf(context, cell) !== null && count > exitsOf(context, cell).size,
  )

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
function failedStateRepetition(context) {
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

const CAPABILITIES = [
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

const VIOLATIONS = [
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

// A capability needs every question answered yes; a violation needs only one. The assertion is not
// defensive noise - a question returning anything but a boolean would silently skew both rules.
function aggregate(answers, kind) {
  const values = Object.values(answers)
  if (!values.every((value) => value === true || value === false)) {
    throw new Error(`non-boolean answer: ${JSON.stringify(answers)}`)
  }

  return kind === "capability" ? values.every(Boolean) : values.some(Boolean)
}

// --- Rounds ---

// answerRubric is the engine's public entry point: it returns the complete rubric result for one
// log as plain data, with each group's per-question answers preserved alongside its verdict.
//
// The group fractions are carried rather than reduced to the verdict because the rubric requires
// partial evidence to stay visible - "2/3" and "0/3" are both a `no`, and collapsing them would hide
// the difference the contract exists to preserve.
// resolveActingAgents maps each turn number to the raw playerName that acted on it.
//
// "Agent request." records the acting seat as a decorated label - "Katara the Trailblazer - Default" -
// not a bare name, so the name is recovered by matching against the names the log states outright:
// every filteredTraversalHistory entry and every round-end agent record. Matching rather than splitting
// on " the " matters because a player may name themselves anything, including something containing that
// phrase; an unmatched label is left unattributed rather than guessed at.
function resolveActingAgents(entries) {
  const known = new Set()
  for (const entry of entries) {
    const details = entry.details ?? {}
    if (details.agent?.playerName) {
      known.add(details.agent.playerName)
    }

    for (const message of details.messages ?? []) {
      if (message.role !== "tool") {
        continue
      }
      try {
        const payload = JSON.parse(message.content ?? "")
        for (const record of payload?.filteredTraversalHistory ?? []) {
          if (record.playerName) {
            known.add(record.playerName)
          }
        }
      } catch {
        // Not a JSON tool result; nothing to learn from it here.
      }
    }
  }

  // Longest first, so a name that is a prefix of another cannot claim the other's turns.
  const names = [...known].sort((first, second) => second.length - first.length)
  const byTurn = new Map()
  for (const entry of entries) {
    if (entry.payload !== LOG_EVENTS.request) {
      continue
    }

    const label = entry.details?.player
    if (typeof label !== "string") {
      continue
    }

    const name = names.find((candidate) => label === candidate || label.startsWith(`${candidate} `))
    if (name && !byTurn.has(entry.turn)) {
      byTurn.set(entry.turn, name)
    }
  }

  return byTurn
}

// buildLevels groups the log into one record per played round and derives the path walked in each.
//
// Rounds are keyed by (game, level) rather than level alone: a retry of the same level is a different
// round with a brand-new maze, so keying on level would merge two mazes into one and draw a path
// crossing walls that exist in neither. buildContext runs per round for the same reason - positions and
// exits from one maze must never leak into another.
export function buildLevels(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const key = `${entry.game ?? 0}/${entry.level ?? 0}`
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push(entry)
  }

  return [...groups.entries()].map(([key, groupEntries]) => {
    const context = buildContext(groupEntries, { label: key })
    const started = groupEntries.find((entry) => entry.payload === LOG_EVENTS.levelStarted)?.details
    const actingAgents = resolveActingAgents(groupEntries)
    const first = groupEntries[0] ?? {}

    const turns = context.submissions.map((submission) => {
      // applied is how many of the submitted moves landed; null means the log did not settle it, which
      // is not the same as zero and must not be drawn as a completed step.
      const landed = submission.applied ?? 0
      const cells = submission.before ? [submission.before] : []
      let cell = submission.before
      for (const move of submission.moves.slice(0, landed)) {
        if (!cell || !MOVES[move]) {
          break
        }
        cell = stepFrom(cell, move)
        cells.push(cell)
      }

      return {
        turn: submission.turn,
        playerName: actingAgents.get(submission.turn) ?? null,
        before: submission.before,
        moves: submission.moves,
        applied: submission.applied,
        cells,
        // The move that was refused, when one was: the first move past those that landed. This is the
        // wall the agent walked into, and it is the single most useful thing to draw on the grid.
        rejectedMove:
          submission.applied !== null && submission.applied < submission.moves.length
            ? submission.moves[submission.applied]
            : null,
      }
    })

    const outcome = context.outcomes.at(-1) ?? null

    // The winning turn is the one turn no later reading can settle: the round ends, so no next request
    // reports a position, and this log's round-end entry carries no lastActionResult either. Its final
    // position is recorded though, so the closing turn is resolved the way annotateApplied resolves
    // every other one - by finding the prefix of submitted moves that lands on the observed cell.
    const endCell = outcome ? cellFromGridPoint(outcome.playerPosition) : null
    const last = turns.at(-1)
    if (last && last.applied === null && endCell && last.before) {
      let cell = last.before
      for (const [step, move] of last.moves.entries()) {
        if (!MOVES[move]) {
          break
        }
        cell = stepFrom(cell, move)
        last.cells.push(cell)
        if (cell === endCell) {
          last.applied = step + 1
          break
        }
      }

      if (last.applied === null) {
        // Nothing lands on the recorded finish, so the walk above proved nothing and its cells are
        // speculation. Drop them rather than draw a path the log does not support.
        last.cells = last.before ? [last.before] : []
      }
    }

    return {
      key,
      game: first.game ?? null,
      level: first.level ?? null,
      encodedMaze: started?.maze ?? null,
      startPosition: started?.startPosition ?? null,
      startCell: cellFromGridPoint(started?.startPosition),
      destinationCell: started?.destinationCell ?? null,
      historyWindowRadius: started?.historyWindowRadius ?? null,
      endCell,
      observedExits: context.exits,
      positions: context.positions,
      turns,
      outcome,
    }
  })
}

// --- Entry point ---

export function answerRubric(entries, { label = "log" } = {}) {
  const context = buildContext(entries, { label })

  const answerGroup = ({id, label: groupLabel, questions, evaluate}, kind) => {
    const answers = evaluate(context)
    if (Object.keys(answers).join() !== Object.keys(questions).join()) {
      throw new Error(`${id} question definitions do not match its evaluated answers`)
    }
    const values = Object.values(answers)
    return {
      id,
      label: groupLabel,
      questions,
      answers,
      met: aggregate(answers, kind),
      passed: values.filter(Boolean).length,
      total: values.length,
    }
  }

  const winningOutcome = context.outcomes.find((outcome) => outcome.outcome === "won")

  return {
    label,
    model: context.model,
    player: context.player,
    predictions: context.submissions.length,
    rounds: context.outcomes.length,
    traversalSpeed: winningOutcome ? Number(winningOutcome.traversalSpeed) : null,
    traversalSpeedClass: winningOutcome ? classifyTraversalSpeed(winningOutcome.traversalSpeed) : null,
    capabilities: CAPABILITIES.map((group) => answerGroup(group, "capability")),
    violations: VIOLATIONS.map((group) => answerGroup(group, "violation")),

    // Operational diagnostics, kept separate from the violation profile on purpose. The rubric notes
    // are explicit that endpoint failures can be caused by infrastructure outside the model's
    // reasoning behavior, so they are preserved as evidence but never scored as a violation.
    diagnostics: {
      endpointFailures: context.endpointFailures,
      emptyResponses: context.emptyResponses,
      unparseableResponses: context.unparseableResponses,
      tokenExhaustions: context.tokenExhaustions,
    },

    // One record per played round, carrying the encoded maze and the path walked through it. Kept
    // separate from the rubric answers above: this is evidence to look at, not a verdict.
    levels: buildLevels(entries),
  }
}

export { CAPABILITIES, VIOLATIONS, aggregate, parsePrediction }
