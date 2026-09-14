// The rubric's own contract: what a round has to be true of itself for its evidence to mean anything.
//
// Its own module, apart from log-contract.ts, because the two answer different questions about the same
// file. That one asks whether the payloads arrived intact - does this decode, does this hash to the
// checksum beside it, does this reconstruct byte-exactly - and it answers them from the bytes alone. The
// checks here read what those payloads were parsed *into*: seats, turns, the totals a round states about
// itself. A checksum failure is a damaged log; a finding here is an intact log describing a run that
// cannot be compared, or one disagreeing with itself.
//
// The practical difference is what each can be given. Nothing here takes a LogEntry: these take the
// summaries rounds.ts derives, which is why they are composed by roundReportFor rather than by parseRound -
// and why adding one needs no new pass over the file.

import type {AgentSummary, CellKey, Outcome, TurnSummary, ValidationCheck} from "./types";

import {asTrimmedText, formatCount} from "./utils";

// --- Entry point: what rubric-report calls ---
//
// Three checks, composed side by side in roundReportFor. Each answers one question and holds no state, so
// a fourth is a function and a line there, and the order they appear in is the order the table reads.

/** The per-turn settings a seat can be found to have changed, and how each is reported.
 *
 * `values: false` for endpoints alone, and not for brevity. This detail is rendered into a table cell, and
 * an endpoint may carry `user:pass@host` - the thing withoutCredentials exists to keep out of the DOM. That
 * function belongs to the view, and a check that reached for it would be deciding how an address is printed
 * as well as whether one moved. The count says drift happened; the Agents table shows the addresses
 * themselves, stripped by the layer that owns that. */
const DRIFTABLE: Array<{label: string; values: boolean; of: (agent: AgentSummary) => readonly string[]}> = [
  {label: "models", values: true, of: (agent) => agent.models},
  {label: "APIs", values: true, of: (agent) => agent.apis},
  {label: "reasoning efforts", values: true, of: (agent) => agent.reasoningEfforts},
  {label: "echo-back settings", values: true, of: (agent) => agent.echoBackReasoning},
  {label: "request intervals", values: true, of: (agent) => agent.requestIntervalSeconds},
  {label: "endpoints", values: false, of: (agent) => agent.endpoints},
];

/** How a seat is named in a finding, where there is no roster index to fall back on. */
const seatName = (agent: AgentSummary): string =>
  agent.name === "" ? `Seat ${agent.seatId ?? "?"}` : agent.name;

/** What one seat changed, as clauses, or none where it held one of everything. */
function driftOf(agent: AgentSummary): string[] {
  return DRIFTABLE.filter((field) => field.of(agent).length > 1).map((field) => {
    const held = field.of(agent);
    const counted = `${formatCount(held.length)} ${field.label}`;
    return field.values ? `${counted} (${held.join(", ")})` : counted;
  });
}

/** seatRosterCheck reports whether the round's seats and players line up one to one.
 *
 * Tapoo seats one player per seat, so the two name the same thing and a log that disagrees with itself
 * cannot be attributed. Both directions are silent failures without this, and they fail differently:
 *
 *   One seat, two players. The second turn is credited to the first player - the seat matches, so the
 *   record is found and its name kept - and the other player's turn disappears into it. One row on the
 *   page, its cells and charge holding two agents' work.
 *
 *   One player, two seats. Two records with the same name, so the page shows the player twice, and
 *   anything that reads a seat by name reaches whichever comes first.
 *
 * Read off the turns rather than the summaries, because a summary is what the disagreement destroys: the
 * first case leaves one record with nothing about it out of place.
 *
 * Turns that state only one of the two say nothing here - a legacy log numbers no turn, and this check has
 * no opinion on it. */
export function seatRosterCheck(turns: readonly TurnSummary[]): ValidationCheck {
  const name = "Seat roster";
  const scope = "round" as const;
  const playersBySeat = new Map<number, Set<string>>();
  const seatsByPlayer = new Map<string, Set<number>>();

  for (const turn of turns) {
    const player = asTrimmedText(turn.playerName);
    if (turn.seatId === null || player === "") continue;
    (playersBySeat.get(turn.seatId) ?? playersBySeat.set(turn.seatId, new Set()).get(turn.seatId)!).add(player);
    (seatsByPlayer.get(player) ?? seatsByPlayer.set(player, new Set()).get(player)!).add(turn.seatId);
  }

  if (playersBySeat.size === 0) {
    return {name, scope, outcome: "unchecked", detail: "no turn stated both a seat and a player"};
  }

  const findings = [
    ...[...playersBySeat].filter(([, players]) => players.size > 1).map(
      ([seatId, players]) => `seat ${seatId} played as ${formatCount(players.size)} players (${[...players].join(", ")})`,
    ),
    ...[...seatsByPlayer].filter(([, seatIds]) => seatIds.size > 1).map(
      ([player, seatIds]) => `${player} played from ${formatCount(seatIds.size)} seats (${[...seatIds].join(", ")})`,
    ),
  ];

  if (findings.length > 0) {
    return {
      name,
      scope,
      outcome: "failed",
      detail: `${findings.join("; ")} - a seat is one player and a player is one seat, so these turns cannot be told apart`,
    };
  }

  return {
    name,
    scope,
    outcome: "passed",
    detail:
      playersBySeat.size === 1
        ? "one seat, one player, throughout"
        : `${formatCount(playersBySeat.size)} seats, one player each, throughout`,
  };
}

/** agentSettingsCheck reports whether each seat answered under one setup for the whole round.
 *
 * A seat that changed model, provider, endpoint or effort mid-round was not one experiment: its turns
 * before and after are not comparable, and a verdict drawn across them compares two setups. The same
 * argument the tool-description check makes, and the reason AgentSummary holds lists - a list longer
 * than one *is* the finding, so nothing is counted twice to reach it.
 *
 * Every drifted seat is named, and every setting each one changed, with the values it changed between.
 * A count alone - "ran 2 different settings" - told a reader that something moved and left them to find
 * what in the Agents table, and reporting only the first seat hid the rest of a finding that is about
 * comparability: a round with two unstable seats is not one bad seat.
 *
 * Stated as a replication problem, because that is the consequence a reader can act on: there is no one
 * setup they could run again to get this profile back, and the row names the settings they would have to
 * choose between to try.
 *
 * Only possible because settings are read per turn. A roster declared once at the start of a round
 * could not contradict itself, so there would be nothing here to check. */
export function agentSettingsCheck(agents: readonly AgentSummary[]): ValidationCheck {
  const name = "Agent settings";
  const scope = "round" as const;
  const stated = agents.filter(
    (agent) =>
      agent.models.length + agent.apis.length + agent.endpoints.length + agent.reasoningEfforts.length > 0,
  );
  if (stated.length === 0) {
    return {name, scope, outcome: "unchecked", detail: "the round recorded no model, provider or effort"};
  }

  const drifted = stated.map((agent) => ({agent, changed: driftOf(agent)}))
    .filter(({changed}) => changed.length > 0);

  if (drifted.length > 0) {
    return {
      name,
      scope,
      outcome: "failed",
      detail:
        `${drifted.map(({agent, changed}) => `${seatName(agent)} ran ${changed.join(" and ")}`).join("; ")}` +
        ` - this makes it hard to replicate this report output/profile.`,
    };
  }

  return {
    name,
    scope,
    outcome: "passed",
    detail:
      stated.length === 1
        ? "one seat, on one model, endpoint and reasoning effort throughout"
        : `${formatCount(stated.length)} seats, each on one model, endpoint and reasoning effort throughout`,
  };
}

/** roundTotalsCheck compares the totals a finished round states about itself against the account its own
 * turns settled.
 *
 * Tapoo closes a round with what the player did over it - cells entered, units charged, turns taken - and
 * the oracle has walked those same turns one at a time. Two readings of one round, and the report is worth
 * more when it says whether they agree than when it quietly prefers one.
 *
 * They disagree in two ways, and only one is a fault. A total the turns cannot bear - more cells than the
 * seat applied moves, or fewer charges than it took turns - is the log contradicting itself, and the seat
 * keeps its own account rather than printing a share above 1. A total merely larger than what the turns
 * settled is ordinary: Tapoo reports a turn's charge on the turn after it, so a round's last charge is
 * usually unreported and the stated figures are the completer ones - which is why agentsFromRound adopts
 * them where the turns can bear them.
 *
 * Pure, and over the same inputs agentsFromRound had, so nothing has to be carried on the records for this
 * to be asked later - and composed by roundReportFor beside agentSettingsCheck, which needs the same two
 * halves of a round. */
export function roundTotalsCheck(turns: readonly TurnSummary[], outcome: Outcome | null): ValidationCheck {
  const name = "Round totals";
  const scope = "round" as const;

  const stated = {
    cells: outcome?.playerUniqueCellsVisited,
    charged: outcome?.decayUnitsCharged,
    turns: outcome?.turnCount,
  };
  if (
    typeof stated.cells !== "number" ||
    typeof stated.charged !== "number" ||
    typeof stated.turns !== "number"
  ) {
    return {name, scope, outcome: "unchecked", detail: "the round states no totals of its own to compare"}
  }

  const entered = new Set<CellKey>();
  let movesApplied = 0;
  let charged = 0;
  for (const turn of turns) {
    for (const cell of turn.cells.slice(1)) entered.add(cell);
    movesApplied += turn.applied ?? 0;
    charged += turn.decayCharged ?? 0;
  }

  // A turn that never settled how many of its moves landed says nothing about how many cells they could
  // have entered, and a round of those sums to no applied moves at all - under which every cell the round
  // states reads as impossible. Not stated is not contradicted, so the cells are compared only where every
  // turn states one, and the detail below says when they could not be.
  const appliedKnown = turns.every((turn) => turn.applied !== null);
  const unstated = appliedKnown ? "" : ", and its turns state no applied count to compare those cells with";

  const impossible = [
    appliedKnown && stated.cells > movesApplied
      ? `${formatCount(stated.cells)} cells entered on ${formatCount(movesApplied)} applied moves`
      : null,
    stated.turns > stated.charged
      ? `${formatCount(stated.turns)} turns charged ${formatCount(stated.charged)} units`
      : null,
  ].filter((one): one is string => one !== null);

  if (impossible.length > 0) {
    return {
      name,
      scope,
      outcome: "failed",
      detail:
        `the round states ${impossible.join(" and ")}, which its own turns cannot account for, so each ` +
        `seat reports what its turns settled instead`,
    }
  }

  const behind = stated.cells - entered.size;
  const unpaid = stated.charged - charged;
  if (behind !== 0 || unpaid !== 0) {
    return {
      name,
      scope,
      outcome: "passed",
      detail:
        `${formatCount(stated.cells)} cells and ${formatCount(stated.charged)} units charged, against ` +
        `${formatCount(entered.size)} and ${formatCount(charged)} the turns settled - the round states ` +
        `what its last turns had not yet reported${unstated}`,
    }
  }

  return {
    name,
    scope,
    outcome: "passed",
    detail:
      `${formatCount(stated.cells)} cells and ${formatCount(stated.charged)} units charged, the same the ` +
      `turns settled${unstated}`,
  }
}
