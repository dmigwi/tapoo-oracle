import { readFileSync } from "node:fs"
import { basename } from "node:path"

// Answers the Tapoo Agentic Behavior Rubric (docs/TAPOO_AGENTIC_BEHAVIOR_RUBRIC.md) against one or
// more exported agent-api gameplay logs.
//
//   node scripts/agentic-analysis.mjs <log.json> [<log.json> ...]
//
// Every question returns strictly true or false, never null. A question quantified over an empty set
// answers false rather than being vacuously true: "all of none complied" is not compliance, and
// reporting it as such would credit a model that never submitted a prediction. A false always means
// "not observed in this sample", never "incapable" - that distinction lives in how results are read,
// which is why no third answer value exists to carry it.
//
// Adding a question means writing a function and listing it in CAPABILITIES or VIOLATIONS. Every
// shared derivation happens once, in buildContext.

const MOVES = {
  MoveUp: [-1, 0],
  MoveDown: [1, 0],
  MoveLeft: [0, -1],
  MoveRight: [0, 1],
}

// Cells are Map/Set keys, so they travel as "row,col" strings rather than arrays, which compare by
// identity and would make every lookup miss.
const cellKey = (row, col) => `${row},${col}`
const stepFrom = (key, move) => {
  const [row, col] = key.split(",").map(Number)
  const [rowDelta, colDelta] = MOVES[move]
  return cellKey(row + rowDelta, col + colDelta)
}

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

// buildContext walks the log once and derives everything the questions need.
function buildContext(path) {
  const { entries } = JSON.parse(readFileSync(path, "utf8"))

  // Logs written before the turn counter landed have no turn field, so turn boundaries are inferred
  // from predictions instead - exactly one closes each turn. Without this every entry collapses onto
  // turn 0 and the per-turn questions pass trivially.
  const hasTurnField = entries.some((entry) => "turn" in entry)

  const context = {
    path,
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

    if (entry.payload === "Agent request.") {
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
            context.exits.set(
              cellKey(record.cell.row, record.cell.col),
              new Set(Object.keys(record.openMoves ?? {})),
            )
          }
        }

        if ("currentCell" in payload) {
          noteTool("get_maze_structure")
          if (payload.currentCell) {
            const cell = cellKey(payload.currentCell.row, payload.currentCell.col)
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

    if (entry.payload === "Agent response.") {
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

    if (entry.payload === "Agent kept re-requesting already-called tools after being told so.") {
      // A warned-mode request only shows the harness issued a warning. Repeating the call after it
      // is what the model did wrong, and this event is the only proof of that.
      context.duplicatesAfterWarning += 1
    } else if (entry.payload === "Agent requested an unknown or hallucinated tool.") {
      context.hallucinated += 1
    } else if (entry.payload === "Agent exhausted the token cap without returning a prediction.") {
      context.tokenExhaustions += 1
    } else if (
      entry.payload === "Provider HTTP response failed." ||
      entry.payload === "Request failed before a valid response."
    ) {
      // Scoped to the agent's own endpoint. Failures inside Tapoo's tool handlers also disable the
      // agent but are Tapoo's fault, so they are deliberately not counted here.
      context.endpointFailures += 1
    } else if (entry.payload === "Agent level won." || entry.payload === "Agent level lost.") {
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

// --- capabilities --------------------------------------------------------

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

// C3. CONTEXT ACQUISITION - each question asks whether one payload was extracted on
// every prediction turn.
function contextAcquisition(context) {
  const turns = [...context.turnsWithPrediction]
  const needed = [
    "get_maze_structure",
    "get_prediction_rules",
    "get_last_prediction_outcome",
  ]

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
  const reading = context.speedReadings.at(-1)
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

// --- violations ----------------------------------------------------------

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

const CAPABILITIES = [
  ["C1", "INSTRUCTION ADHERENCE", instructionAdherence],
  ["C2", "VALID ACTION DELIVERY", validActionDelivery],
  ["C3", "CONTEXT ACQUISITION", contextAcquisition],
  ["C4", "STATE AWARENESS", stateAwareness],
  ["C5", "RESOURCE EFFICIENCY", resourceEfficiency],
  ["C6", "MULTI-STEP EXECUTION", multiStepExecution],
  ["C7", "STRUCTURAL REASONING", structuralReasoning],
  ["C8", "ADAPTIVE RECOVERY", adaptiveRecovery],
  ["C9", "TASK COMPLETION", taskCompletion],
]

const VIOLATIONS = [
  ["V1", "TOOL HALLUCINATION", hallucinations],
  ["V2", "OUTPUT CONTRACT FAILURE", outputContractFailure],
  ["V3", "WARNING DISREGARD", warningDisregard],
  ["V4", "AVAILABLE-CONTEXT DISREGARD", availableContextDisregard],
  ["V5", "RESOURCE WASTE", resourceWaste],
  ["V6", "FAILED-STATE REPETITION", failedStateRepetition],
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

function report(context) {
  const title = context.model ?? basename(context.path)
  const rounds = context.outcomes.length
  console.log(`\n${"=".repeat(66)}`)
  console.log(
    `${title}   (player: ${context.player ?? "unknown"}, ` +
      `${context.submissions.length} predictions, ${rounds} rounds)`,
  )
  console.log("=".repeat(66))

  for (const [heading, group, kind] of [
    ["CAPABILITIES", CAPABILITIES, "capability"],
    ["\nVIOLATIONS", VIOLATIONS, "violation"],
  ]) {
    console.log(heading)
    for (const [id, label, answer] of group) {
      const answers = answer(context)
      const verdict = aggregate(answers, kind) ? "YES" : "no "
      const detail = Object.entries(answers)
        .map(([question, value]) => `${question}:${value ? "Y" : "n"}`)
        .join(" ")
      console.log(`  ${verdict}  ${id} ${label.padEnd(28)} ${detail}`)
    }
  }
}

const logs = process.argv.slice(2)
if (logs.length === 0) {
  console.error("usage: node scripts/agentic-analysis.mjs <log.json> [<log.json> ...]")
  process.exit(1)
}

for (const log of logs) {
  report(buildContext(log))
}
