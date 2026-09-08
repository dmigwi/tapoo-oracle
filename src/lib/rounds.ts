// Rounds: what happened in each played level, as the maze replay needs it.
//
// Separate from the rubric engine because this derives evidence rather than answering a question - it
// is the replay's input, not a verdict. It reads the same context the engine builds, one round at a
// time, because a retry of a level is a different maze and merging the two would draw a path crossing
// walls that exist in neither.

import { LOG_EVENTS, cellKeyFromLogged, isMove, stepFrom } from "./log-contract"
import { cellFromGridPoint } from "./maze"
import { buildContext } from "./rubric-engine"
import { gameIdentityKey } from "./log-index"
import { asArray, asRecord } from "./utils"

// Re-exported: a caller naming a round reaches for this file, and that is still where it looks.
export { gameIdentityKey } from "./log-index"
import type { CellKey, Context, EncodedMaze, GameIdentity, Level, LogEntry, Replay, Turn } from "./types"

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

// reportedMoves reads the move list out of a replay record, or null when it holds none.
//
// The names are stripped of any "player:" prefix the way annotateApplied strips them - some producer
// writes them that way, and the real logs to hand do not, so both must read the same.
function reportedMoves(record: Replay | null): string[] | null {
  if (!record) return null
  const moves = asArray(record.lastSubmittedMoves)
    .filter((move): move is string => typeof move === "string")
    .map((move) => move.split(":").at(-1) ?? move)

  return moves.length > 0 ? moves : null
}

/** One played round's entries, with the identity the log stamped on them. */
export type RoundGroup = {
  /** Which round these entries belong to. */
  identity: GameIdentity;
  entries: LogEntry[];
};

/** roundLabel names a round the way a reader would say it out loud. The key is an address, not a label -
 * "2/1" beside a filename reads as a fraction or a date before it reads as a round. */
export function roundLabel({game, level}: GameIdentity): string {
  const parts = [
    typeof game === "number" ? `Game ${game}` : null,
    typeof level === "number" ? `Level ${level}` : null,
  ].filter(Boolean);
  // A log that never stamps either field is still one round, and it still needs something to click.
  return parts.length > 0 ? parts.join(" \u00b7 ") : "Whole log";
}

/** groupEntriesByRound splits a log into the rounds it recorded, in the order they were played.
 *
 * The one definition of what a round is. The replay reads it to build a maze per round, and the report
 * reads it to answer the rubric per round; two partitions that could disagree would put a verdict on a
 * tab whose maze came from somewhere else. */
export function groupEntriesByRound(entries: LogEntry[]): RoundGroup[] {
  // An entry that does not name its round belongs to the round in progress.
  //
  // Reading `entry.game ?? "?"` per entry instead filed every such entry under a fabricated round "?/?".
  // On a log that stamps game and level only on its round boundaries, that split one real round in two:
  // a round holding the encoded maze and no turns, and a phantom round holding all the turns and no
  // maze. The reader saw a replay whose scrubber ran 0 to 0 and a Turns column reading zero, on a log
  // with hundreds of them.
  //
  // Entries are in recorded order, so the round in progress is whatever the last entry to name one
  // said. Anything before the first such entry is held back and joins the round that opens after it -
  // it cannot belong to an earlier one, because there is none.
  const groups = new Map<string, RoundGroup>()
  const beforeFirstRound: LogEntry[] = []
  let game: number | null = null
  let level: number | null = null

  for (const entry of entries) {
    if (typeof entry.game === "number") game = entry.game
    if (typeof entry.level === "number") level = entry.level

    if (game === null && level === null) {
      beforeFirstRound.push(entry)
      continue
    }

    const key = gameIdentityKey({game, level})
    // Identity comes from the running cursor, not from the group's first entry: on a log that stamps
    // game and level only on round boundaries, the first entry of a group often carries neither, and a
    // tab labelled from it would read "Whole log" beside fourteen properly named siblings.
    const group = groups.get(key) ?? {identity: {game, level}, entries: []}
    if (group.entries.length === 0 && groups.size === 0 && beforeFirstRound.length > 0) {
      group.entries.push(...beforeFirstRound.splice(0))
    }
    group.entries.push(entry)
    groups.set(key, group)
  }

  // A log that never names a round at all: one round, everything in it, as before.
  if (beforeFirstRound.length > 0) {
    groups.set(gameIdentityKey({game: null, level: null}), {identity: {game: null, level: null}, entries: beforeFirstRound})
  }

  return [...groups.values()]
}

/** buildLevels groups the log into one record per played round and derives the path walked in each.
 *
 * Rounds are keyed by (game, level) rather than level alone: a retry of the same level is a different
 * round with a brand-new maze, so keying on level would merge two mazes into one and draw a path
 * crossing walls that exist in neither. buildContext runs per round for the same reason - positions and
 * exits from one maze must never leak into another. */
export function buildLevels(entries: LogEntry[], answered?: Context): Level[] {
  const groups = groupEntriesByRound(entries)

  return groups.map(({identity, entries: groupEntries}) => {
    // The caller's context when it has one, which is now the common case: answerRubric has already
    // built a context over exactly these entries, and building a second identical one was the largest
    // avoidable cost of opening a log.
    //
    // Only when there is one group. With several, each needs its own - positions and exits from one
    // maze leaking into another is the bug this file exists to prevent - and the caller's context spans
    // all of them. Nothing here reads context.label, which is the only field that would differ.
    const context = answered !== undefined && groups.length === 1
      ? answered
      : buildContext(groupEntries, { label: gameIdentityKey(identity) })
    const started = asRecord(
      groupEntries.find((entry) => entry.payload === LOG_EVENTS.levelStarted)?.details,
    )
    const actingAgents = resolveActingAgents(groupEntries)

    // Keyed by the turn it covers, so this is a plain lookup. The offset that used to live here - Tapoo
    // reports a prediction's outcome on the request that follows it - now belongs to the store that
    // holds these records. A later record must never be substituted: repeated move sequences could make
    // one look compatible while attributing another turn's position, charge and applied count to this.
    const recordFor = (turn: number): Replay | null => context.replayByTurn.get(turn) ?? null

    const turns = context.submissions.map((submission) => {
      // What Tapoo said about this turn, if the next turn reported it. Preferred over the derivation
      // below because it states where replay began and which move was the last to land, rather than
      // inferring both from positions - and because inferring them was wrong on 13.6% of the turns of
      // a real log, always on a multi-move batch.
      const record = recordFor(submission.turn)
      const reported = reportedMoves(record)

      // Only trusted when it describes this turn's prediction. If the two disagree the cursor has
      // landed on someone else's record, and a wrong path drawn confidently is worse than a derived
      // one - so it falls through to the derivation instead.
      const trusted =
        record !== null &&
        reported !== null &&
        reported.length === submission.moves.length &&
        reported.every((move, index) => move === submission.moves[index])

      const startCell = trusted ? cellKeyFromLogged(record.lastReplayStartCell) : null
      const appliedIndex = record?.lastAppliedMoveIndex
      const applied = trusted
        ? typeof appliedIndex === "number"
          ? appliedIndex + 1
          : 0
        : submission.applied ?? null

      const before = (trusted ? startCell : null) ?? submission.before ?? null

      // applied is how many of the submitted moves landed; null means the log did not settle it, which
      // is not the same as zero and must not be drawn as a completed step.
      const landed = applied ?? 0
      const cells: CellKey[] = before ? [before] : []
      let cell = before
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
        before,
        moves: submission.moves,
        applied,
        cells,
        decayCharged:
          trusted && typeof record.chargedMovesCount === "number" ? record.chargedMovesCount : null,
        // The move that was refused, when one was: the first move past those that landed. This is the
        // wall the agent walked into, and it is the single most useful thing to draw on the grid.
        rejectedMove:
          typeof applied === "number" && applied < submission.moves.length
            ? (submission.moves[applied] as string | undefined) ?? null
            : null,
      }

      return turn
    })

    // A turn that produced no prediction is a turn all the same.
    //
    // When a response is malformed, exhausts the token cap, or fails on the wire, there are no moves to
    // replay - nothing becomes a submission, and the turn used to vanish from the replay entirely.
    // Tapoo counted it and charged for it regardless, three units, its heaviest penalty. So the report
    // showed fewer turns than the round had (464 against Tapoo's own 473 in one log), and the decay
    // strip could never add up to the round total because its most expensive turns were missing.
    //
    // `empty-prediction` is Tapoo's own marker for exactly this, so it is read rather than inferred.
    const predicted = new Set(turns.map((turn) => turn.turn))
    for (const [turn, replay] of context.replayByTurn.ascending()) {
      // turn -1 is the payload logged on turn 0, which covers no turn.
      if (replay.predictionStatus !== "empty-prediction" || turn < 0 || predicted.has(turn)) {
        continue
      }

      turns.push({
        turn,
        playerName: actingAgents.get(turn) ?? null,
        before: null,
        moves: [],
        applied: 0,
        cells: [],
        rejectedMove: null,
        decayCharged: typeof replay.chargedMovesCount === "number" ? replay.chargedMovesCount : null,
      })
    }
    turns.sort((left, right) => left.turn - right.turn)

    // A turn that submitted nothing did not move, so it stands where the turn before it ended. Without
    // this the scrubber would jump the agent back to the start on every empty turn.
    let standing: CellKey | null = null
    for (const turn of turns) {
      if (turn.cells.length > 0) {
        standing = turn.cells.at(-1) ?? standing
        continue
      }

      turn.before = standing
      turn.cells = standing ? [standing] : []
    }

    const outcome = context.outcomes.at(-1) ?? null

    // The closing turn's charge is the only one no reading can carry, because no turn follows it to
    // report it. The round total settles it by subtraction.
    //
    // Subtract every reported charge, not just the ones that reached a turn above. A turn that made no
    // prediction still reports one, and glm-5.1 has 473 log turns against 464 predictions - summing
    // only the attributed charges handed those nine turns' cost to the closing turn and made it 28
    // instead of 1.
    //
    // Guarded on the readings covering every turn the round says it had. Without that, a turn that
    // never called the tool leaves a hole the remainder would absorb just as silently.
    const closing = turns.at(-1)
    const roundCharge = outcome ? Number(outcome.decayUnitsCharged) : Number.NaN
    const roundTurns = outcome ? Number(outcome.turnCount) : Number.NaN
    const everyTurnReported =
      Number.isFinite(roundTurns) && context.replayByTurn.size === roundTurns

    if (closing && closing.decayCharged === null && everyTurnReported && Number.isFinite(roundCharge)) {
      let reportedTotal = 0
      for (const replay of context.replayByTurn.values()) {
        reportedTotal += typeof replay.chargedMovesCount === "number" ? replay.chargedMovesCount : 0
      }

      const remainder = roundCharge - reportedTotal
      if (remainder >= 0) {
        closing.decayCharged = remainder
      }
    }

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
      identity,
      encodedMaze: (started.maze ?? null) as EncodedMaze | null,
      startPosition,
      startCell: cellFromGridPoint(startPosition),
      // Read through the contract's reader rather than assumed to be {row, col}: the same field
      // arrives compacted as [row, col] in a downloaded log, and reading it directly is what left the
      // destination undrawn and the shortest route reported as "no route found".
      destinationCell: cellKeyFromLogged(started.destinationCell),
      historyWindowRadius:
        typeof started.historyWindowRadius === "number" ? started.historyWindowRadius : null,
      endCell,
      observedExits: context.exits,
      visitStatusAfterTurn: context.visitStatusAfterTurn,
      positions: context.positions,
      turns,
      outcome,
    }

    return level
  })
}
