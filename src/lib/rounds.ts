// Rounds: what happened in each played level, as the maze replay needs it.
//
// Separate from the rubric engine because this derives evidence rather than answering a question - it
// is the replay's input, not a verdict. It reads the same context the engine builds, one round at a
// time, because a retry of a level is a different maze and merging the two would draw a path crossing
// walls that exist in neither.

import { LOG_EVENTS, cellFromLogged, isMove, stepFrom } from "./log-contract"
import { cellFromGridPoint } from "./maze"
import { asArray, asRecord, buildContext } from "./rubric-engine"
import type { CellKey, EncodedMaze, Level, LogEntry, Turn } from "./types"


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
function resolveActingAgents(entries: LogEntry[]): Map<number, string> {
  const known = new Set<string>()
  for (const entry of entries) {
    const details = asRecord(entry.details)
    const agentName = asRecord(details.agent).playerName
    if (typeof agentName === "string" && agentName) {
      known.add(agentName)
    }

    for (const message of asArray(details.messages).map(asRecord)) {
      if (message.role !== "tool") {
        continue
      }
      try {
        const payload = asRecord(JSON.parse(typeof message.content === "string" ? message.content : ""))
        for (const record of asArray(payload.filteredTraversalHistory).map(asRecord)) {
          if (typeof record.playerName === "string" && record.playerName) {
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
  const byTurn = new Map<number, string>()
  for (const entry of entries) {
    if (entry.payload !== LOG_EVENTS.request || typeof entry.turn !== "number") {
      continue
    }

    const label = asRecord(entry.details).player
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
export function buildLevels(entries: LogEntry[]): Level[] {
  const groups = new Map<string, LogEntry[]>()
  for (const entry of entries) {
    const key = `${entry.game ?? 0}/${entry.level ?? 0}`
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }

  return [...groups.entries()].map(([key, groupEntries]) => {
    const context = buildContext(groupEntries, { label: key })
    const started = asRecord(
      groupEntries.find((entry) => entry.payload === LOG_EVENTS.levelStarted)?.details,
    )
    const actingAgents = resolveActingAgents(groupEntries)
    const first = groupEntries[0]

    const turns = context.submissions.map((submission) => {
      // applied is how many of the submitted moves landed; null means the log did not settle it, which
      // is not the same as zero and must not be drawn as a completed step.
      const landed = submission.applied ?? 0
      const cells: CellKey[] = submission.before ? [submission.before] : []
      let cell = submission.before
      for (const move of submission.moves.slice(0, landed)) {
        if (!cell || !isMove(move)) {
          break
        }
        cell = stepFrom(cell, move)
        cells.push(cell)
      }

      const turn: Turn = {
        turn: submission.turn,
        playerName: actingAgents.get(submission.turn) ?? null,
        before: submission.before ?? null,
        moves: submission.moves,
        applied: submission.applied ?? null,
        cells,
        // The move that was refused, when one was: the first move past those that landed. This is the
        // wall the agent walked into, and it is the single most useful thing to draw on the grid.
        rejectedMove:
          typeof submission.applied === "number" && submission.applied < submission.moves.length
            ? (submission.moves[submission.applied] as string | undefined) ?? null
            : null,
      }

      return turn
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
        if (!isMove(move)) {
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

    const startPosition = (started.startPosition ?? null)
    const level: Level = {
      key,
      game: first?.game ?? null,
      level: first?.level ?? null,
      encodedMaze: (started.maze ?? null) as EncodedMaze | null,
      startPosition,
      startCell: cellFromGridPoint(startPosition),
      // Read through the contract's reader rather than assumed to be {row, col}: the same field
      // arrives compacted as [row, col] in a downloaded log, and reading it directly is what left the
      // destination undrawn and the shortest route reported as "no route found".
      destinationCell: cellFromLogged(started.destinationCell),
      historyWindowRadius:
        typeof started.historyWindowRadius === "number" ? started.historyWindowRadius : null,
      endCell,
      observedExits: context.exits,
      positions: context.positions,
      turns,
      outcome,
    }

    return level
  })
}
