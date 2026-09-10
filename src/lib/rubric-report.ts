// One round's report: what buildReport composes, and the rubric answers it is composed from.
//
// Named for the rubric rather than the report, like rubric-engine beneath it: this is the bottom of
// the report path, not the top. report-view and report-adapters are the two files above it, and a
// module called "report.ts" sitting below both of them read as the one they came from.
//
// Composed here rather than inside the engine because it needs both halves - the engine's answers and
// the round's replay record - and having the engine import the rounds would make the two mutually
// dependent for no reason other than where the composition happened to sit.
//
// buildReport first, then the rubric pass it calls: the file reads in the order the work happens.

import { classifyTraversalSpeed } from "./log-contract"
import { buildLevels } from "./rounds"
import { CAPABILITIES, VIOLATIONS, aggregate, buildContext } from "./rubric-engine"
import type { Context, GroupKind, GroupResult, LogEntry, Report, RubricGroup } from "./types"

// --- Entry point: what log-tabs calls ---

/** buildReport reads one round's entries once and returns everything the page shows about that round,
 * as plain data. Called by log-tabs.roundReportFor, which memoizes what comes back.
 *
 * Three steps, each owned elsewhere:
 *
 *   buildContext (rubric-engine) reads the entries into the facts every question is answered from;
 *   buildLevels (rounds)         derives the round's replay record from that same context;
 *   answerRubric (below)         answers the capability and violation groups against it.
 *
 * What this function itself does is compose those three and name the facts a reader reads beside the
 * verdicts - the seats, the token counts, the prediction count, the winning speed, the diagnostics. */
export function buildReport(entries: LogEntry[], { label = "log" }: { label?: string } = {}): Report {
  const context = buildContext(entries, { label })

  // Built once and read twice: the report's agent summaries come from the same round the replay draws,
  // so the two cannot disagree about who played. This is handed one round's entries, so buildLevels
  // regroups them into the one round it already has.
  const level = buildLevels(entries, context)[0] ?? null

  const {capabilities, violations} = answerRubric(context)
  const winningOutcome = context.outcomes.find((outcome) => outcome.outcome === "won")

  return {
    label,
    agents: level?.agents ?? [],
    output: {...context.output, finishReasons: [...context.output.finishReasons]},
    predictions: context.submissions.length,
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

    level,
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
