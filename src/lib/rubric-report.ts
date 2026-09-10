// One round's report: the answered round a reader opens, what buildReport composes it from, and the
// rubric itself - every question, its definition, and the verdict it produces.
//
// Named for the rubric rather than the report, like rubric-context beneath it: this is the bottom of
// the report path, not the top. report-view and report-adapters are the two files above it, and a
// module called "report.ts" sitting below both of them read as the one they came from.
//
// The questions live here rather than in the engine because they are the rubric, not the reading:
// rubric-context walks a round once and states what it found, and every question below is a predicate
// over that. Definitions sit beside their evaluators so the report cannot describe a different
// question than the one that was answered, and adding a question means writing a function and listing
// it in CAPABILITIES or VIOLATIONS.
//
// Every question returns strictly true or false, never null. A question quantified over an empty set
// answers false rather than being vacuously true: "all of none complied" is not compliance, and
// reporting it as such would credit a model that never submitted a prediction. A false always means
// "not observed in this sample", never "incapable" - that distinction lives in how results are read,
// which is why no third answer value exists to carry it.
//
// roundReportFor is the entry - it is what report-view asks for - and beneath it buildReport, the
// rubric pass it calls, and then the questions themselves: the file reads in the order the work
// happens.

import { DECLARED_TOOLS, agentSettingsCheck, classifyTraversalSpeed, parseRound, seatRosterCheck, stepFrom } from "./log-contract"
import { buildPlayedRound } from "./rounds"
import { buildContext } from "./rubric-context"
import type {
  CellKey,
  Context,
  GroupKind,
  GroupResult,
  LogEntry,
  Move,
  Report,
  RoundReport,
  RoundSlice,
  RubricGroup,
  TurnPrediction,
} from "./types"



// --- Entry point: what report-view calls ---

// Answered rounds, keyed by the slice they were answered from.
//
// A WeakMap rather than a field on the slice: the slices live inside a log tab's state, which the
// reducers replace wholesale on every change, and a cache written into that state would either be
// copied around or mutated in place. Keyed by object identity instead, so it survives a re-render -
// updateLogTab keeps `result` by reference - and is collected with the tab when it closes.
const answered = new WeakMap<RoundSlice, RoundReport>();

/** roundReportFor answers one round, once: its rubric verdicts and its own caveats.
 *
 * This is where a log stops being cheap. Opening a file reads its envelope and slices it into rounds;
 * everything expensive - the rubric pass, the maze decode, the checksum reconstruction - happens here,
 * for the round a reader actually opened, rather than all fourteen of a fourteen-round file up front.
 *
 * Memoized, so returning to a round is free and the object identity of what the view holds is stable
 * across renders. */
export function roundReportFor(slice: RoundSlice): RoundReport {
  const cached = answered.get(slice);
  if (cached) return cached;

  const report = buildReport(slice.entries, {label: slice.reportLabel});
  const round = parseRound(slice.entries);
  const resolved: RoundReport = {
    ...slice,
    report,
    // Composed here because the check needs both halves: parseRound reads the round's payloads and
    // knows nothing of seats, while the summaries come from the answered report. Neither should have to
    // reach for the other to say whether a seat's setup held for the whole round.
    round: {
      ...round,
      checks: [
        ...round.checks,
        // Over the round's turns, which is where a seat and a player are stated together. A round that
        // decoded no maze still has turns to check, so this reads the turns and not the maze.
        seatRosterCheck(report.playedRound?.turns ?? []),
        agentSettingsCheck(report.agents),
      ],
    },
  };
  answered.set(slice, resolved);
  return resolved;
}

// --- Building one round's report ---

/** buildReport reads one round's entries once and returns everything the page shows about that round,
 * as plain data. Called by roundReportFor above, which memoizes what comes back.
 *
 * Three steps, each owned elsewhere:
 *
 *   buildContext (rubric-context) reads the entries into the facts every question is answered from;
 *   buildPlayedRound (rounds)   derives the round's maze and path from that same context;
 *   answerRubric (below)         answers the capability and violation groups against it.
 *
 * What this function itself does is compose those three and name the facts a reader reads beside the
 * verdicts - the seats, the token counts, the prediction count, the winning speed, the diagnostics. */
export function buildReport(entries: LogEntry[], { label = "log" }: { label?: string } = {}): Report {
  const context = buildContext(entries, { label })

  // Built once and read twice: the report's agent summaries come from the same round the replay draws,
  // so the two cannot disagree about who played. The context travels with the entries it was built
  // from - buildPlayedRound never builds a second one.
  const playedRound = buildPlayedRound(entries, context)

  const {capabilities, violations} = answerRubric(context)
  const winningOutcome = context.outcomes.find((outcome) => outcome.outcome === "won")

  return {
    label,
    agents: playedRound?.agents ?? [],
    output: {...context.output, finishReasons: [...context.output.finishReasons]},
    predictions: context.predictions.length,
    traversalSpeed: winningOutcome ? Number(winningOutcome.traversalSpeed) : null,
    traversalSpeedClass: winningOutcome ? classifyTraversalSpeed(winningOutcome.traversalSpeed) : null,
    capabilities,
    violations,

    // Operational diagnostics, kept separate from the violation profile on purpose. The rubric notes
    // are explicit that endpoint failures can be caused by infrastructure outside the model's
    // reasoning behavior, so they are preserved as evidence but never scored as a violation.
    diagnostics: {
      endpointFailures: context.endpointFailures,
      agentDisablings: context.agentDisablings,
      harnessFailures: context.harnessFailures,
      emptyResponses: context.emptyResponses,
      unparseableResponses: context.unparseableResponses,
      tokenExhaustions: context.tokenExhaustions,
    },

    playedRound,
  }
}

// --- The rubric pass ---

/** answerRubric answers every rubric group against one round's context: the capabilities and the
 * violations, each with its per-question answers preserved alongside its verdict.
 *
 * The group fractions are carried rather than reduced to the verdict because the rubric requires
 * partial evidence to stay visible - "2/3" and "0/3" are both a `no`, and collapsing them would hide
 * the difference the contract exists to preserve. */
export function answerRubric(context: Context): {capabilities: GroupResult[]; violations: GroupResult[]} {
  const answerGroup = (
    {id, label: groupLabel, questions, evaluate}: RubricGroup,
    kind: GroupKind,
  ): GroupResult => {
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

  return {
    capabilities: CAPABILITIES.map((group) => answerGroup(group, "capability")),
    violations: VIOLATIONS.map((group) => answerGroup(group, "violation")),
  }
}

// --- Shared predicates ---

const exitsOf = (context: Context, cell: CellKey | null | undefined): Set<Move> | null =>
  (cell === null || cell === undefined ? null : context.exits.get(cell)) ?? null

const isCorridor = (context: Context, cell: CellKey | null | undefined): boolean =>
  exitsOf(context, cell)?.size === 2

const fullyApplied = (record: TurnPrediction): boolean => record.applied === record.submittedCount

// inConfirmedCorridorRun reports whether at least two forced steps ahead are already known safe:
// both the current cell and the one the move leads into are confirmed two-exit corridors. That is
// the shape where batching costs nothing extra and single-stepping wastes a free decay unit.
function inConfirmedCorridorRun(context: Context, cell: CellKey, move: Move | undefined): boolean {
  if (move === undefined || !isCorridor(context, cell) || !exitsOf(context, cell)?.has(move)) {
    return false
  }

  return isCorridor(context, stepFrom(cell, move))
}


// --- Capability questions ---

// C1. INSTRUCTION ADHERENCE   scope: responses a moves array was extracted from
function instructionAdherence(context: Context): Record<string, boolean> {
  const predictions = context.predictions
  if (predictions.length === 0) {
    return { Q1: false, Q2: false, Q3: false }
  }

  return {
    // Q1. Are all prediction responses bare JSON, no fences or prose?
    Q1: predictions.every((entry) => entry.tier === 1),
    // Q2. Do all carry no fields beyond "moves"?
    //
    // Settled at the parse boundary, like Q3: a prediction naming any other top-level field carries it
    // here, and an empty list is the shape the protocol asks for.
    Q2: predictions.every((entry) => entry.invalidFormatKeys === ""),
    // Q3. Are all move commands one of MoveUp / MoveDown / MoveLeft / MoveRight?
    //
    // Settled at the parse boundary: a prediction whose applicable prefix is shorter than what it sent
    // holds a command the maze has no move for - "Up" where the protocol says "MoveUp".
    Q3: predictions.every((entry) => entry.moves.length === entry.submittedCount),
  }
}

// C2. VALID ACTION DELIVERY
// Q1. Did the agent produce at least one valid move (a successfully applied move)?
function validActionDelivery(context: Context): Record<string, boolean> {
  return { Q1: context.predictions.some((entry) => (entry.applied ?? 0) > 0) }
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
  const checkable = context.predictions.filter((entry) => entry.before && exitsOf(context, entry.before))
  if (checkable.length === 0) {
    return { Q1: false }
  }

  return {
    Q1: checkable.every((entry) => {
      const known = exitsOf(context, entry.before)
      // The first *applicable* move: a command the maze cannot apply is absent from the prefix, and it
      // could never be a member of an exits set that holds Moves either way.
      const first = entry.moves[0]
      return known !== null && first !== undefined && known.has(first)
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
  const batches = context.predictions.filter((entry) => entry.submittedCount >= 2)
  return {
    // Q1. Did the agent make any batched (2+ move) prediction?
    Q1: batches.length > 0,
    // Q2. Did any batched prediction fully apply?
    Q2: batches.some(fullyApplied),
  }
}

// C7. STRUCTURAL REASONING
function structuralReasoning(context: Context): Record<string, boolean> {
  const batches = context.predictions.filter((entry) => entry.submittedCount >= 2)
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
  const predictions = context.predictions
  for (const [index, failed] of predictions.entries()) {
    const next = predictions[index + 1]
    if (!next || typeof failed.applied !== "number" || typeof next.applied !== "number") {
      continue
    }

    if (failed.applied < failed.submittedCount && next.applied >= 2) {
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
  return { Q1: context.predictions.some((entry) => {
    if (!entry.before) {
      return false
    }

    // A command the maze has no move for is not among any cell's stated exits, so a prediction that
    // sent one disregarded the context by definition - and the prefix no longer holds it to be checked.
    if (entry.moves.length < entry.submittedCount) {
      return true
    }

    let cell = entry.before
    for (const move of entry.moves) {
      const known = exitsOf(context, cell)
      if (!known || cell === null || cell === undefined) {
        return false
      }
      // A move that is not among the cell's stated exits disregards the context - that is the question.
      if (!known.has(move)) {
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
  const declinedFreeBatch = context.predictions.some(
    (entry) =>
      entry.submittedCount === 1 &&
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
  for (const entry of context.predictions) {
    if (!entry.before || entry.applied === null) {
      continue
    }

    const key = JSON.stringify([entry.before, entry.moves, entry.submittedCount])
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
