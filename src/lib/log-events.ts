// The Tapoo log vocabulary: the identity of an export, the sentences it writes, and what each one
// means about who is answerable for it.
//
// Its own module because several files need it and none can own it: log-contract validates entries
// against it, rubric-engine counts by it, and report-adapters reads its classes. Holding it in
// log-contract made those files import the contract to name an event, closing cycles whose
// module-evaluation order decides whether a top-level `const` exists yet.

import type {LogClass, LogLevel} from "./types";

// --- Export identity ---

/** LOG_CONTRACT_VERSION is the version of the *log shape*, not of Tapoo. It is independent of the
 * APP_VERSION stamped into an export, because the log shape changes far less often than the app:
 * tying consumers to the app version would reject logs on every unrelated patch release. */
export const LOG_CONTRACT_VERSION = 1;

/** LOG_ENVELOPE_NAME is the constant tapooDownloadLogs writes to the envelope's `name` field. It is
 * what distinguishes a Tapoo log from any other JSON a user might paste into an analyzer. */
export const LOG_ENVELOPE_NAME = "tapoo";

/** AGENT_API_MODE is the only control mode that produces these logs. tapooDownloadLogs returns early
 * for anything else, so an export naming a different mode did not come from an agent round. */
export const AGENT_API_MODE = "agent-api";

/** LOG_LEVELS mirrors the LogLevel union in frontend/app/types.ts. */
export const LOG_LEVELS = new Set<string>(["error", "info", "warn"]);

// --- What a log says ---

/** LOG_EVENTS is the payload sentence vocabulary the analyzer branches on. These strings are the
 * stable identity of an event - the payload field is prose, but it is *fixed* prose, and matching it
 * exactly is how an entry's meaning is recovered.
 *
 * Naming them here rather than inlining the literals is what makes a producer-side wording change a
 * one-line fix instead of a silent behavioral drift spread across the analyzer, where a stale
 * literal simply stops matching and quietly answers every dependent question "no". */
export const LOG_EVENTS = {
  levelStarted: "Agent level started.",
  request: "Agent request.",
  response: "Agent response.",
  levelWon: "Agent level won.",
  levelLost: "Agent level lost.",
  duplicateToolWarningIgnored: "Agent kept re-requesting already-called tools after being told so.",
  hallucinatedTool: "Agent requested an unknown or hallucinated tool.",
  tokenCapExhausted: "Agent exhausted the token cap without returning a prediction.",
  providerHttpFailure: "Provider HTTP response failed.",
  requestFailed: "Request failed before a valid response.",
  agentDisabled: "Agent disabled after network error.",
  emptyProviderResponse: "Provider response did not include a message.",
  malformedPrediction: "Malformed agent prediction response.",
  unsupportedProvider: "Unsupported agent API provider.",
  toolServiceFailure: "Tool request could not be serviced.",
} as const;

// --- Log levels as classification ---

/** levelClassOf reads an entry's level as the statement of accountability Tapoo means it to be - see
 * `LogLevel` for what each one says.
 *
 * This is worth reading because the payload sentence is not a complete vocabulary. "Recovered after a
 * connection-error retry." is written by a real log and named nowhere in LOG_EVENTS, so it falls through
 * every branch in buildContext and is counted nowhere. The level classifies it anyway. */
export function levelClassOf(level: LogLevel): LogClass {
  if (level === "warn") return "penalised";
  if (level === "error") return "external";
  return "neutral";
}

/** EVENT_CLASSES is the class each known event is expected to carry, used to cross-check the level
 * rather than to replace it. The split mirrors what the rubric already does: duplicate-tool and hallucinated-tool
 * events feed the violation profile, while endpoint failures are kept out of it because they can come
 * from infrastructure rather than reasoning. */
export const EVENT_CLASSES: Record<string, LogClass> = {
  [LOG_EVENTS.levelStarted]: "neutral",
  [LOG_EVENTS.request]: "neutral",
  [LOG_EVENTS.response]: "neutral",
  [LOG_EVENTS.levelWon]: "neutral",
  [LOG_EVENTS.levelLost]: "neutral",
  [LOG_EVENTS.duplicateToolWarningIgnored]: "penalised",
  [LOG_EVENTS.hallucinatedTool]: "penalised",
  [LOG_EVENTS.tokenCapExhausted]: "penalised",
  [LOG_EVENTS.providerHttpFailure]: "external",
  [LOG_EVENTS.requestFailed]: "external",
  [LOG_EVENTS.agentDisabled]: "external",
  [LOG_EVENTS.emptyProviderResponse]: "external",
  [LOG_EVENTS.malformedPrediction]: "penalised",
  [LOG_EVENTS.unsupportedProvider]: "external",
  [LOG_EVENTS.toolServiceFailure]: "external",
};

/** KNOWN_EVENTS is the set of payload sentences the rubric can score. An entry outside it is readable
 * and real - it just has no question attached to it. */
export const KNOWN_EVENTS = new Set<string>(Object.values(LOG_EVENTS));

/** DECLARED_TOOLS are the context tools Tapoo declares to an agent. C3 asks one question per tool, in
 * this order, so the order is part of the contract rather than an implementation detail. */
export const DECLARED_TOOLS = [
  "get_maze_structure",
  "get_prediction_rules",
  "get_last_prediction_outcome",
] as const;
