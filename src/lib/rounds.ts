// Rounds: which rounds a log holds, and what happened in each of them.
//
// Three parts of one question. sliceLogIntoRounds cuts a parsed log into one slice per round,
// agentsFromRound reads a round into one record per seat, and buildPlayedRounds derives what the
// replay draws from a round's entries.
//
// Separate from the rubric engine because this derives evidence rather than answering a question - it
// is the replay's input, not a verdict. It reads the same context the engine builds, one round at a
// time, because a retry of a level is a different maze and merging the two would draw a path crossing
// walls that exist in neither.

import { LOG_EVENTS, cellKeyFromLogged, isMove, stepFrom } from "./log-contract"
import { cellFromGridPoint } from "./maze"
import { buildContext } from "./rubric-engine"
import { gameIdentityKey } from "./geometry"
import { asArray, asRecord, asTrimmedText } from "./utils"

// Re-exported: a caller naming a round reaches for this file, and that is still where it looks.
export { gameIdentityKey } from "./geometry"
import type {
  AgentSummary,
  CellKey,
  Context,
  EncodedMaze,
  GameIdentity,
  PlayedRound,
  LogEntry,
  Outcome,
  ParsedLog,
  RawTurnSetup,
  Replay,
  RoundSlice,
  SlicedLogResult,
  TurnSummary
} from "./types"

// --- Entry point: what log-tabs-state calls ---

/** sliceLogIntoRounds cuts a parsed log into one slice per round, passing the log's warnings and checks
 * through untouched.
 *
 * A round is the unit every verdict is about: each is an independent game with its own maze, start cell
 * and decay budget.
 *
 * A slice is entries and an identity, so this costs no rubric pass - that is roundReportFor's, run for
 * the round a reader opens. */
export function sliceLogIntoRounds({source, warnings, checks}: ParsedLog, label: string): SlicedLogResult {
  const [first, ...rest]: RoundSlice[] = groupEntriesByRound(source.entries).map(({identity, entries}) => ({
    identity,
    reportLabel: `${label} - ${roundLabel(identity)}`,
    entries,
  }));

  // Unreachable: parseTapooLogText refuses a log with no readable entries, and groupEntriesByRound
  // groups any non-empty list - a log naming no round still gets one holding everything. Stated once
  // here, so no render has to guard the empty case.
  if (!first) {
    return {ok: false, error: "This log analyzed to no rounds, so there is nothing to report."};
  }

  return {
    ok: true,
    source,
    warnings,
    checks,
    rounds: [first, ...rest],
  };
}

// --- Reading one round ---

/** The decorated label a request carries, and the player's name inside it.
 *
 * Tapoo writes "<player> the <Persona> - <speed>": "Katara the Trailblazer - Default",
 * "Momo the Backtracker - 0.4360x". Three personas, and a name of 3 to 8 characters.
 *
 * The name is whatever precedes " the <Persona> - ", which is a different rule from splitting on " the ":
 * a name may itself contain that phrase and still fit in eight characters, and a split hands back "A"
 * where the player is "A the B".
 *
 * Both bounds and the persona set are stated rather than assumed, and together they leave one reading of
 * any label. A name of 11 characters in that position is not a player, so a string of this shape reports
 * nobody rather than inventing one; the quantifier's greediness does no work here, because within three to
 * eight characters no label admits two parses.
 *
 * The cost of naming the personas is that a fourth stops resolving until it is added - visible as a seat
 * missing from the round, which is the failure to watch for if Tapoo adds one. */
const PLAYER_LABEL = /^(.{3,8}) the (?:Backtracker|Navigator|Trailblazer) - .+$/

/** resolveActiveAgentNames maps each turn number to the name of the agent that was active on it.
 *
 * Active is the whole of what a turn records about a seat: only an active agent may predict, so a request
 * is a turn taken by exactly one of them, and the name on it is that agent's.
 *
 * Exported for its own tests rather than for a caller: nothing outside this file needs it, and everything
 * per-seat is joined by the name it returns - a turn it leaves unattributed is a turn whose charge, cells
 * and setup belong to nobody, and a seat that acted goes unreported. A failure here is silent by
 * construction, so it is checked directly.
 *
 * Two sources, and the request carries both. `details.playerName` is the name stated outright, which needs
 * no recovery at all; `details.player` is the decorated label, which PLAYER_LABEL reads. Nothing else in
 * the log is consulted - a round-end record names only whoever finished, and reading it here would
 * attribute every turn of a two-seat round to one of them.
 *
 * This is the only thing that attributes a turn. */
export function resolveActiveAgentNames(entries: LogEntry[]): Map<number, string> {
  const byTurn = new Map<number, string>()

  for (const entry of entries) {
    if (entry.payload !== LOG_EVENTS.request || typeof entry.turn !== "number") continue
    // One turn, one seat. A retry of a turn is that seat asking again, so the first request answers for it.
    if (byTurn.has(entry.turn)) continue

    const details = asRecord(entry.details)
    if (typeof details.playerName === "string" && details.playerName !== "") {
      byTurn.set(entry.turn, details.playerName)
      continue
    }

    const name = typeof details.player === "string" ? PLAYER_LABEL.exec(details.player)?.[1] : undefined
    if (name) byTurn.set(entry.turn, name)
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
  const groupedRounds: RoundGroup[] = []
  let roundEntries: LogEntry[] = []
  
  // The key every entry recorded before the log names its first round carries.
  const UNNAMED_ROUND_KEY = gameIdentityKey({game: null, level: null});

  // The round the entry in hand belongs to. Carried forward rather than read off the entry, because an
  // entry that names no round belongs to the round in progress - and game and level advance
  // independently, so a log that stamps one without the other still names a round, "2/?".
  let currentRound: GameIdentity = {game: null, level: null}

  // The same two values one entry back, which is the round every entry gathered so far belongs to.
  let prevRound: GameIdentity = currentRound
  let prevRoundKey = UNNAMED_ROUND_KEY

  for (const entry of entries) {
    currentRound = {
      game: typeof entry.game === "number" ? entry.game : currentRound.game,
      level: typeof entry.level === "number" ? entry.level : currentRound.level,
    }

    // Nothing is closed while the previous round is still the unnamed one: those entries were recorded
    // before the log named any round, so they join the round about to open rather than forming one of
    // their own.
    const currentRoundKey = gameIdentityKey(currentRound)
    if (prevRoundKey !== UNNAMED_ROUND_KEY && currentRoundKey !== prevRoundKey) {
      groupedRounds.push({identity: prevRound, entries: roundEntries})
      roundEntries = [] // clear old entries.
    }

    roundEntries.push(entry)
    prevRound = currentRound
    prevRoundKey = currentRoundKey
  }

  // The round still being gathered has no successor to close it, and a log that named no round at all
  // is gathered entirely here - one round, holding everything.
  if (roundEntries.length > 0) {
    groupedRounds.push({identity: prevRound, entries: roundEntries})
  }

  return groupedRounds
}

// --- The agents that played a round ---

/** agentsFromRound reads one round into one record per seat: what each was running, and what it did.
 *
 * A single pass, deliberately. The setup half and the performance half were once gathered in two places,
 * one of them a set of parallel arrays whose rows held together only by shared index, and neither could
 * answer "what was seat 2 running". One record per seat cannot come apart that way.
 *
 * Here rather than in log-contract, which validates a round's payloads: this asks who played and under
 * what, which is evidence about the round rather than a check on it - the same thing buildPlayedRounds
 * below derives, and its only production caller.
 *
 * Takes the setup map rather than the whole Context: it reads one field, and a caller with turns and an
 * outcome should not have to build a rubric context to name the seats that played them.
 *
 * Seats are ordered by the seat the log stated, and by who acted first where it stated none. */
export function agentsFromRound(
  rawSetupByTurn: ReadonlyMap<number, RawTurnSetup>,
  turns: readonly TurnSummary[],
  outcome: Outcome | null,
): AgentSummary[] {
  const seats: AgentSummary[] = []

  // Two side tables keyed by the record itself, never by anything read off it. seatInfoAt below is the one
  // answer to which seat a turn belongs to, and a derived key would be a second - free to disagree with it,
  // and wrong in three ways:
  //
  //   By name, two seats that state their numbers and no player both answer to "".
  //   By seat number, every seat on a log that numbers no turn answers to null.
  //   By the two joined, a seat whose number arrives on a later turn changes key mid-pass, and everything
  //   filed under the old one is orphaned - half a walk, half its echoes.
  //
  // A Map keyed by an object matches on the reference and never reads what is inside, so the arrays these
  // records carry cost nothing to key on, and filling them in while the record is a key is safe. Which is
  // just as well: the fold does exactly that.
  //
  // The echoes are held apart from what was declared. An echo drops the ":provider" suffix that says
  // where the model was served from - "gemma4" for a declared "gemma4:cloud", and on Hugging Face
  // "moonshotai/Kimi-K3" for "moonshotai/Kimi-K3:baseten" - so the declared name is the fuller of the two
  // and the one to report. This list is only consulted for a seat nothing declared a model for.
  const echoes = new Map<AgentSummary, string[]>()
  const entered = new Map<AgentSummary, Set<CellKey>>()

  const emptySummary = (name: string, seatId: number | null): AgentSummary => {
    const seat: AgentSummary = {
      name,
      seatId,
      models: [],
      apis: [],
      endpoints: [],
      reasoningEfforts: [],
      uniqueCells: null,
      decayCharged: null,
      traversalSpeed: null,
    }
    seats.push(seat)
    return seat
  }
  const add = (list: string[], value: string | null): void => {
    if (value !== null && !list.includes(value)) list.push(value)
  }

  /** The seat a turn belongs to, by the stated seat where there is one and by name otherwise.
   *
   * Tapoo gives each seat one player and one id, so either identifies a seat on its own. The stated seat
   * is preferred because it is stated: it arrives on the request as a number, where the name arrives only
   * after resolveActiveAgentNames has recovered it from a decorated label, which can fail - and a turn whose
   * recovery failed still says outright which seat played it.
   *
   * Falls back to the name because a log that states no seat is still the common case, and to null: a
   * turn with neither cannot be attributed, and guessing which seat it was is worse than saying nothing. */
  const seatInfoAt = (seatId: number | null, name: string): AgentSummary | null => {
    if (seatId !== null) {
      const stated = seats.find((seat) => seat.seatId === seatId)
      // A record can be made before its name is known - a turn that states its seat and no name - so the
      // first turn to state one fills it in.
      if (stated) {
        if (stated.name === "" && name !== "") stated.name = name
        return stated
      }

      // The same seat, met earlier on a turn that named it without numbering it. Adopting the record
      // rather than opening a second one keeps a mixed round - some turns stating a seat, some not - as
      // one seat rather than two halves of one.
      const unnumbered = name === ""
        ? undefined
        : seats.find((seat) => seat.seatId === null && seat.name === name)
      if (unnumbered) {
        unnumbered.seatId = seatId
        return unnumbered
      }

      return emptySummary(name, seatId)
    }

    if (name === "") return null
    return seats.find((seat) => seat.name === name) ?? emptySummary(name, null)
  }

  // Every turn is played by exactly one seat, so a turn's setup, its charge and its cells are that
  // seat's. One pass for all three: they are joined by the same identity, and computing them apart is
  // what let a row be assembled out of two lists that agreed only by index.
  //
  // Unique cells *entered*, which is cells.slice(1) and not the whole walk. TurnSummary.cells opens with
  // `before`, the cell the seat was already standing on, so the whole array is "where I was, then
  // everywhere I went". Counting all of it credits a seat with a cell it never moved into, and for turn 0
  // that cell is the start square - which Tapoo does not treat as the player's at all: its traversal
  // history labels the start "Self" on every reading, and its outcome record counts 17 unique cells where
  // the walk touches 18. For later turns the slice changes nothing, cells[0] already being in the set
  // from the turn before, so this is precisely the start-square correction and it is what makes the count
  // reconcile with playerUniqueCellsVisited.
  for (const turn of turns) {
    const setup = rawSetupByTurn.get(turn.turn)
    // The seat off the turn, not off the setup map beside it. Both carry it - buildPlayedRounds fills one from
    // the other - but the replay reads the turn, and one authority is what keeps a trail's colour and
    // the row above it naming the same seat.
    const seat = seatInfoAt(turn.seatId, turn.playerName ?? "")
    if (!seat) continue

    if (setup) {
      add(seat.models, setup.model)
      if (setup.echoedModel !== null) {
        const echoed = echoes.get(seat) ?? []
        add(echoed, setup.echoedModel)
        echoes.set(seat, echoed)
      }
      add(seat.apis, setup.api)
      add(seat.endpoints, setup.endpoint)
      add(seat.reasoningEfforts, setup.reasoning)
    }

    if (turn.decayCharged !== null) seat.decayCharged = (seat.decayCharged ?? 0) + turn.decayCharged

    const seen = entered.get(seat) ?? new Set<CellKey>()
    for (const cell of turn.cells.slice(1)) seen.add(cell)
    entered.set(seat, seen)
  }

  for (const [seat, seen] of entered) seat.uniqueCells = seen.size

  // The outcome names one seat - whoever made the final dash - and carries its speed and, in v2.5.1, the
  // only seatId the log states anywhere. Matched by that seat first, since that is the identity, and by
  // name only for the logs that state no seat on a turn. Older logs name nobody, and a round with a
  // single seat still has exactly one owner, so that case is attributed rather than dropped.
  const record = asRecord(outcome?.agent)
  const owner = asTrimmedText(record.playerName)
  const ownerSeatId = typeof record.seatId === "number" ? record.seatId : null

  /** Which seat the outcome is about, or undefined where the round cannot say.
   *
   * Four cases in order, each a different question about the same record. Ordered, not combined: the
   * later ones are only right once the earlier ones have found nothing, and the last has a side effect. */
  const resolveFinisher = (): AgentSummary | undefined => {
    // The seat it states. That is the log's own answer, and it holds even for a seat whose name no turn
    // resolved.
    if (ownerSeatId !== null) {
      const stated = seats.find((seat) => seat.seatId === ownerSeatId)
      if (stated) return stated
    }

    // The name it states, which is all a log that numbers no turn has to offer.
    if (owner !== "") {
      const named = seats.find((seat) => seat.name === owner)
      if (named) return named
    }

    // It names nobody, so there is nothing to match on. One seat played means one seat owns the outcome;
    // with several, attributing it would be guessing, and the guess would credit whoever acted first.
    if (owner === "" && ownerSeatId === null) return seats.length === 1 ? seats[0] : undefined

    // It names a seat no turn produced - which happens when a log's requests carry nothing to attribute
    // turns by. That seat played and the outcome is the log saying so, so it joins the roster here:
    // dropping it reports a round as having no agents at all while the log plainly names one.
    return emptySummary(owner, ownerSeatId)
  }

  const finisher = resolveFinisher()

  if (finisher) {
    const speed = Number(outcome?.traversalSpeed)
    if (Number.isFinite(speed)) finisher.traversalSpeed = speed
    // Only where the turns did not already state one: a request that names its own seat is the better
    // source, being per turn rather than per round.
    if (ownerSeatId !== null) finisher.seatId ??= ownerSeatId
    // The record declares a model the same way a request does, so it joins the declared list rather than
    // standing in for it.
    add(finisher.models, asTrimmedText(record.model) || null)
  }

  // The echo, only where nothing declared a model - better than reporting no model at all, and it names
  // the same model, just without the provider. Never alongside a declared name: the two are one model
  // named twice, and listing both would read as a seat that ran two models, which is exactly what
  // agentSettingsCheck reports as a finding.
  for (const seat of seats) {
    if (seat.models.length === 0) seat.models.push(...(echoes.get(seat) ?? []))
  }

  // A stated seat is the log's answer and beats the order they happened to act in.
  return seats.sort((first, second) =>
    first.seatId !== null && second.seatId !== null ? first.seatId - second.seatId : 0,
  )
}

/** buildPlayedRounds groups the log into one PlayedRound per played round, deriving the path
 * walked through each maze.
 *
 * Rounds are keyed by (game, level) rather than level alone: a retry of the same level is a different
 * round with a brand-new maze, so keying on level would merge two mazes into one and draw a path
 * crossing walls that exist in neither. buildContext runs per round for the same reason - positions and
 * exits from one maze must never leak into another. */
export function buildPlayedRounds(entries: LogEntry[], answered?: Context): PlayedRound[] {
  const groups = groupEntriesByRound(entries)

  return groups.map(({identity, entries: groupEntries}) => {
    // The caller's context when it has one, which is the common case: buildReport has already built a
    // context over exactly these entries, and building a second identical one is the largest avoidable
    // cost of opening a log.
    //
    // Only when there is one group. With several, each needs its own - positions and exits from one
    // maze leaking into another is the bug this file exists to prevent - and the caller's context spans
    // all of them. Nothing here reads context.label, which is the only field that would differ.
    const context = answered !== undefined && groups.length === 1
      ? answered
      : buildContext(groupEntries, { label: gameIdentityKey(identity) })
    const initLevelLog = asRecord(
      groupEntries.find((entry) => entry.payload === LOG_EVENTS.levelStarted)?.details,
    )
    const activeAgentNames = resolveActiveAgentNames(groupEntries)

    // Keyed by the turn it covers, so this is a plain lookup. The offset behind that - Tapoo reports a
    // prediction's outcome on the request that follows it - belongs to the store holding these records,
    // not to its callers. A later record must never be substituted: repeated move sequences could make
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
      const trusted = record !== null && reported !== null &&
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

      const turn: TurnSummary = {
        turn: submission.turn,
        seatId: context.rawSetupByTurn.get(submission.turn)?.seatId ?? null,
        playerName: activeAgentNames.get(submission.turn) ?? null,
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
    // replay - nothing becomes a submission, so without this the turn is absent from the replay.
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
        seatId: context.rawSetupByTurn.get(turn)?.seatId ?? null,
        playerName: activeAgentNames.get(turn) ?? null,
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

    const startPosition = (initLevelLog.startPosition ?? null)
    const round: PlayedRound = {
      identity,
      encodedMaze: (initLevelLog.maze ?? null) as EncodedMaze | null,
      startPosition,
      startCell: cellFromGridPoint(startPosition),
      // Read through the contract's reader rather than assumed to be {row, col}: the same field
      // arrives compacted as [row, col] in a downloaded log, and reading it directly is what left the
      // destination undrawn and the shortest route reported as "no route found".
      destinationCell: cellKeyFromLogged(initLevelLog.destinationCell),
      historyWindowRadius: typeof initLevelLog.historyWindowRadius === "number" ? initLevelLog.historyWindowRadius : null,
      endCell,
      observedExits: context.exits,
      visitStatusAfterTurn: context.visitStatusAfterTurn,
      positions: context.positions,
      turns,
      outcome,
      agents: agentsFromRound(context.rawSetupByTurn, turns, outcome),
    }

    return round
  })
}
