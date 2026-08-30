# Tapoo Agentic Behavior Rubric Notes

These notes hold evaluator details and interpretation aids that are useful when
implementing the rubric, but too specific for the main rubric contract.

## Dependency Ladders

Some questions are stronger forms of others. A stronger YES can imply a weaker
YES, but the reverse is not true.

```text
full-depth landed batch -> landed batch -> any batch
corridor compression -> landed batch -> any batch
two-move recovery -> any batch
Trailblazer-speed completion -> task completion
Trailblazer-speed completion -> resource efficiency -> valid action delivery
state-aware action, efficient traversal, landed batching, structural reasoning,
adaptive recovery, or task completion -> valid action delivery
```

## Duplicate Events

Duplicate tool-call warnings are only violations after the model repeats the
warned behavior. The warning itself is not evidence of disregard.

## Endpoint Failures

Endpoint failures are useful operational diagnostics. They should be preserved
in analysis output when available, but they are excluded from the violation
profile because they can be caused by infrastructure outside the model's
reasoning behavior.

## Rejected Candidate Groups

`CONTROLLED RISK-TAKING` is intentionally excluded. Risk without supporting
structure is not a capability; successful structure-informed batching belongs
under `STRUCTURAL REASONING`.
