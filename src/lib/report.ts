// answerRubric: the one call that turns a log into a report.
//
// Composed here rather than inside the engine because it needs both halves - the engine's answers and
// the rounds' replay data - and having the engine import the rounds would make the two mutually
// dependent for no reason other than where the composition happened to sit.

import { classifyTraversalSpeed } from "./log-contract"
import { buildLevels } from "./rounds"
import { CAPABILITIES, VIOLATIONS, aggregate, buildContext } from "./rubric-engine"
import type { GroupKind, GroupResult, LogEntry, Report, RubricGroup } from "./types"



export function answerRubric(entries: LogEntry[], { label = "log" }: { label?: string } = {}): Report {
  const context = buildContext(entries, { label })

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

  const winningOutcome = context.outcomes.find((outcome) => outcome.outcome === "won")

  return {
    label,
    model: context.model,
    player: context.player,
    apis: [...context.apis],
    reasoningEfforts: [...context.reasoningEfforts],
    output: {...context.output, finishReasons: [...context.output.finishReasons]},
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

