# Tapoo Agentic Behavior Active Measurement Contract

This active measurement contract evaluates what an agent demonstrably did in a
Tapoo `agent-api` gameplay log. It is a factual reasoning profile, not a
scorecard: every capability and violation is answered from logged evidence, and
no weighted or combined intelligence score is produced.

## Purpose and Boundary

Tapoo is used here as a standardized tool task. The rubric does not ask which
model is the best maze player. It asks what reasoning behavior the sampled
agent actually demonstrated while using the same declared tools, response
contract, and game rules.

Only observed facts count. Missing evidence answers NO, meaning "not observed
in this sample," not "the model is incapable."

## Result Format

- Report capabilities and violations separately.
- Keep each group fraction visible, such as `2/3` or `5/5`, so partial evidence
  is not hidden.
- Preserve exact numeric evidence, including traversal speed, token counts, and
  prediction counts.
- Do not collapse capabilities and violations into one score interval.

## Evaluation Rules

- Every question returns strictly `YES` or `NO`.
- Empty evidence returns `NO`.
- Capabilities use AND semantics: every grouped question must return `YES`.
- Violations use OR semantics: any grouped question returning `YES` confirms the
  violation.
- Evaluate each level independently before aggregating the complete sample.
- Combined behavior must occur within the same level.

## Capability Groups

| ID | Group | General behavior profiled |
|---|---|---|
| C1 | `INSTRUCTION ADHERENCE` | Follows declared task, tool, and response instructions. |
| C2 | `VALID ACTION DELIVERY` | Produces an executable action accepted by the environment. |
| C3 | `CONTEXT ACQUISITION` | Requests the information needed for an informed decision. |
| C4 | `STATE AWARENESS` | Selects actions consistent with confirmed current state. |
| C5 | `RESOURCE EFFICIENCY` | Converts the agent's own decay budget into unique progress. |
| C6 | `MULTI-STEP EXECUTION` | Successfully executes sequences rather than relying only on isolated actions. |
| C7 | `STRUCTURAL REASONING` | Uses known structure successfully and achieves a Trailblazer-speed win in the same level. |
| C8 | `ADAPTIVE RECOVERY` | Changes course after a proven failure and subsequently makes valid progress. |
| C9 | `TASK COMPLETION` | Reaches the objective in any sampled level, regardless of speed classification. |

C9 confirms every win. C7 additionally requires direct structural evidence and
a winning traversal speed above `1.0000`.

```text
C1. INSTRUCTION ADHERENCE
    scope: responses a moves array was extracted from

    Q1. Are all prediction responses bare JSON, with no fences or prose?
    Q2. Does every prediction JSON object have exactly one top-level key,
        "moves"?
    Q3. Are all move commands one of MoveUp / MoveDown / MoveLeft / MoveRight?
```

```text
C2. VALID ACTION DELIVERY
    Q1. Did the agent produce at least one successfully applied move?
```

```text
C3. CONTEXT ACQUISITION
    one question per context tool

    Q1. Did the agent extract the maze structure on every prediction turn?
        Required facts: level, currentCell, destinationCell, nearby
        filteredTraversalHistory, each included cell's openMoves.

    Q2. Did the agent extract the prediction rules on every prediction turn?
        Required facts: suggestedMovesPerTurn, mazeDimensions,
        traversal-speed inputs, batchEfficiencyClass, expected response schema.

    Q3. Did the agent extract the last prediction outcome on every prediction
        turn?
        Required facts: status, score, lastMoveStatus, chargedMovesCount, and
        prior submitted/applied move details.
```

```text
C4. STATE AWARENESS
    Q1. On every turn where the currentCell appeared in filteredTraversalHistory,
        was the first submitted move one of that cell's confirmed openMoves?
```

```text
C5. RESOURCE EFFICIENCY
    Q1. At round end, was the evaluated agent's traversal speed at least 1.0000?
        Formula: currentAgentUniqueCellsFirstVisited /
        currentAgentDecayUnitsCharged.
```

```text
C6. MULTI-STEP EXECUTION
    Q1. Did the agent submit any 2+ move prediction?
    Q2. Did the agent submit any 2+ move prediction where every move applied?
```

```text
C7. STRUCTURAL REASONING
    Q1. Did the agent submit a 2+ move prediction through confirmed known
        structure where every move applied?
    Q2. Did the same sampled level end with that agent winning at Trailblazer
        speed above 1.0000?
```

```text
C8. ADAPTIVE RECOVERY
    Q1. After a failed turn, did the following turn's prediction have its first
        two consecutive moves applied?
```

```text
C9. TASK COMPLETION
    Q1. Did the agent win by reaching the destination in any sampled level?
```

## Violation Groups

| ID | Group | General behavior profiled |
|---|---|---|
| V1 | `TOOL HALLUCINATION` | Attempts to invoke an undeclared interface. |
| V2 | `OUTPUT CONTRACT FAILURE` | Returns a final response that cannot satisfy the required contract. |
| V3 | `WARNING DISREGARD` | Repeats behavior after receiving a relevant corrective warning. |
| V4 | `AVAILABLE-CONTEXT DISREGARD` | Produces an action contradicting confirmed information. |
| V5 | `RESOURCE WASTE` | Provably wastes action or output budget, including excessive revisitation and standardized token exhaustion. |
| V6 | `FAILED-STATE REPETITION` | Repeats an action sequence already proven invalid from the same state. |

Endpoint failures are operational diagnostics, not model-intelligence
violations.

```text
V1. TOOL HALLUCINATION
    Q1. Did the agent call any tool outside the declared tools set?
```

```text
V2. OUTPUT CONTRACT FAILURE
    Q1. Did any final response fail to produce an extractable prediction?
        Includes unparseable content, invalid final content, or second
        token-limit exhaustion after a warning.

    Q2. Did any final response contain valid JSON with an empty "moves" array?
```

```text
V3. WARNING DISREGARD
    Q1. Did the agent repeat a duplicate tool call after receiving a duplicate
        tool-call warning?
    Q2. Did the agent hit the completion-token cap for a second time after the
        corrective token-limit warning?
```

```text
V4. AVAILABLE-CONTEXT DISREGARD
    Q1. Did the agent submit any move that was not among the current cell's
        confirmed openMoves?
```

```text
V5. RESOURCE WASTE
    Q1. Did the agent enter any cell more times than that cell's openMoves
        count permits?
    Q2. Did the agent single-step through confirmed known structure where a
        multi-step prediction was available?
    Q3. Did any response reach the configured completion-token cap?
```

```text
V6. FAILED-STATE REPETITION
    Q1. Did the agent repeat, from the same currentCell, a moves array already
        proven invalid from that same cell?
```

## Agent-Scoped Traversal Speed

Use one formula everywhere:

```text
agentTraversalSpeed =
    currentAgentUniqueCellsFirstVisited /
    currentAgentDecayUnitsCharged
```

- `currentAgentUniqueCellsFirstVisited` counts traversal-history entries
  attributed to that agent's `playerName`.
- `currentAgentDecayUnitsCharged` includes only decay charged to that agent
  during the current level.
- The seeded `Self` start cell and cells first visited by other agents never
  enter the numerator.
- Decay charged to other agents never enters the denominator.
- The winning agent is the agent whose action reached the destination.
- The winning turn's progress and decay must both be included.
- A non-positive denominator resolves to speed `0`, never a default
  Trailblazer result.

Classifications:

| Class | Meaning |
|---|---|
| `Backtracker` | below `1.0000` |
| `Navigator` | exactly `1.0000` |
| `Trailblazer` | above `1.0000` |

A higher winning Trailblazer speed represents a larger observed efficiency
margin and a greater expected likelihood of remaining competitive at higher
levels. It is probabilistic evidence, not a guaranteed future result.

## Minimal Evidence Definitions

- A **turn** is one agent prediction cycle.
- A **prediction** is the final `moves` array submitted at the end of a turn.
- A **level win** occurs when Tapoo records that an action reached the
  destination.
- A **confirmed current state** is information returned by declared Tapoo tools
  or by Tapoo's replay outcome for that level.
- `allUniqueCellsVisited` is collective exploration context only. It must never
  be used as the numerator for individual agent traversal speed.
- Token exhaustion is a resource-waste signal when it is observed against the
  configured completion-token cap.
