// Tapoo agent-api log contract.
//
// This module is the single definition of what a downloaded Tapoo log looks like, shared by every
// consumer that reads one: the CLI in scripts/agentic-analysis.mjs, and the Oracle analytics app in
// src/. There is exactly one copy, so the two front ends cannot answer the same log differently.
//
// It deliberately imports no dependencies and no node: builtins, so it runs unchanged in Node and in a
// browser bundle.
//
// The producer of this shape is frontend/app/logs.ts (tapooDownloadLogs) writing entries typed as
// LogEntry in frontend/app/types.ts. When that producer changes, this file changes with it, and
// LOG_CONTRACT_VERSION below is what tells a consumer it is looking at something it does not know
// how to read.

import type {
  EncodedMaze,
  LogWarning,
  AssistantMessage,
  ResponseUsage,
  LogEntry,
  LogParseResult,
  LogTextResult,
  TapooLog,
} from "./types";

import {asTrimmedText} from "./untrusted";
import {indexLog} from "./log-index";
import {mazeFromEncoded} from "./maze";

export {
  AGENT_API_MODE,
  DECLARED_TOOLS,
  EVENT_CLASSES,
  KNOWN_EVENTS,
  LOG_CONTRACT_VERSION,
  LOG_ENVELOPE_NAME,
  LOG_EVENTS,
  LOG_LEVELS,
  levelClassOf,
} from "./log-events";
import {AGENT_API_MODE, LOG_ENVELOPE_NAME, LOG_EVENTS, LOG_LEVELS} from "./log-events";

// Re-exported: every caller of these is reading the log contract, and that is still where they look.
export {
  MOVES,
  cellFromLogged,
  cellKey,
  classifyTraversalSpeed,
  isMove,
  movesFromLogged,
  stepFrom,
} from "./geometry";

// --- Reading a provider response ---

// assistantMessage reads one model response, whichever of the three providers produced it.
//
// Tapoo logs the provider's response body verbatim, so the shape belongs to the provider. Its own
// adapters (frontend/app/agent/providers.ts) define all three, and they agree on nothing structural:
//
//   Ollama     {message: {content, thinking, tool_calls}}                 - verified against real logs
//   OpenAI     {choices: [{message: {content, reasoning_content, tool_calls}}]}  - verified
//   Anthropic  {content: [{type: "text"|"thinking"|"tool_use", ...}]}     - from the adapter only
//
// The Anthropic branch is written from Tapoo's adapter and covered by tests built from it, but no
// Anthropic log has ever been run through it. It is kept rather than dropped because the alternative
// is worse than an unverified reader: without it an Anthropic log returns null here, and null now
// raises a warning that says the responses could not be read (see unreadableResponseWarnings) instead
// of failing silently the way the OpenAI shape did.
//
// Reading only Ollama's shape is what made a whole log analyze to nothing: every OpenAI response has
// no `message` at the root, so each counted as empty - zero predictions, zero turns, and a replay
// scrubber reading "0 / 0" under a maze that drew correctly. Anthropic would have failed the same way
// for the same reason, so all three are read here rather than two.
//
// Providers are told apart by shape, not by the `api` field or the endpoint URL. Both are recorded in
// the log and either would work, but a body that looks like a response is better evidence about that
// body than a label written beside it.
export function assistantMessage(payload: unknown): AssistantMessage | null {
  const body = asRecordOrEmpty(payload);

  // Ollama, then OpenAI: both wrap a single message object.
  const wrapped =
    isRecord(body.message)
      ? body.message
      : (() => {
          const [choice] = Array.isArray(body.choices) ? (body.choices as unknown[]) : [];
          // Only the first choice. Tapoo asks for one completion, and scoring a second would credit
          // the agent with a prediction it was never judged on.
          const message = asRecordOrEmpty(choice).message;
          return isRecord(message) ? message : null;
        })();

  if (wrapped) {
    return {
      content: typeof wrapped.content === "string" ? wrapped.content : null,
      toolNames: toolNamesOf(wrapped.tool_calls),
      // `thinking` is Ollama's name and `reasoning_content` is OpenAI's for the same thing.
      reasoning:
        typeof wrapped.thinking === "string"
          ? wrapped.thinking
          : typeof wrapped.reasoning_content === "string"
            ? wrapped.reasoning_content
            : null,
    };
  }

  // Anthropic: typed content blocks, no wrapper. Text and thinking can each arrive in several blocks,
  // so both are concatenated rather than taken from the first.
  if (!Array.isArray(body.content)) {
    return null;
  }

  let content = "";
  let reasoning = "";
  const toolNames: string[] = [];

  for (const block of body.content as unknown[]) {
    const record = asRecordOrEmpty(block);
    if (record.type === "text" && typeof record.text === "string") content += record.text;
    else if (record.type === "thinking" && typeof record.thinking === "string") reasoning += record.thinking;
    else if (record.type === "tool_use" && typeof record.name === "string") toolNames.push(record.name);
  }

  return {
    content: content === "" ? null : content,
    toolNames,
    reasoning: reasoning === "" ? null : reasoning,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const asRecordOrEmpty = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

// Ollama and OpenAI both use OpenAI's tool-call shape: a list of {function: {name}}.
function toolNamesOf(calls: unknown): string[] {
  if (!Array.isArray(calls)) return [];
  return (calls as unknown[])
    .map((call) => asRecordOrEmpty(asRecordOrEmpty(call).function).name)
    .filter((name): name is string => typeof name === "string" && name !== "");
}

// responseUsage reads what the provider reported about its own work, from either API shape.
//
// The two report overlapping but different things, so every field is nullable and a null means "this
// provider did not say" rather than zero. Ollama counts tokens at the payload root and times the whole
// call; OpenAI nests counts under `usage` and adds the two that matter most for a reasoning model -
// how many of the completion tokens were spent thinking, and how much of the prompt was served from
// cache rather than re-read.
export function responseUsage(payload: unknown): ResponseUsage {
  const body = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

  const usage = record(body.usage);
  const [choice] = Array.isArray(body.choices) ? (body.choices as unknown[]) : [];

  const firstString = (...values: unknown[]): string | null => {
    for (const value of values) if (typeof value === "string" && value !== "") return value;
    return null;
  };

  return {
    // Ollama counts at the payload root; OpenAI and Anthropic nest under `usage` with different names.
    promptTokens: num(body.prompt_eval_count) ?? num(usage.prompt_tokens) ?? num(usage.input_tokens),
    // Anthropic's output_tokens already includes its extended-thinking tokens, which is why they are
    // not added on top - doing so would double-count the thinking against the completion budget.
    completionTokens: num(body.eval_count) ?? num(usage.completion_tokens) ?? num(usage.output_tokens),
    reasoningTokens: num(record(usage.completion_tokens_details).reasoning_tokens),
    cachedPromptTokens:
      num(record(usage.prompt_tokens_details).cached_tokens) ?? num(usage.cache_read_input_tokens),
    durationNs: num(body.total_duration),
    // Ollama's done_reason, OpenAI's per-choice finish_reason, Anthropic's stop_reason.
    finishReason: firstString(body.done_reason, record(choice).finish_reason, body.stop_reason),
  };
}

// --- Validating an export ---

// isLogEntry reports whether one array element carries the fields every consumer relies on. turn,
// level, and game are checked but not required to be present: logs written before those counters
// landed still analyze correctly, and buildContext has an explicit fallback for a missing turn.
function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.payload === "string" &&
    typeof entry.epochMs === "number" &&
    typeof entry.log === "string" &&
    LOG_LEVELS.has(entry.log)
  );
}

// parseTapooLogExport validates a parsed JSON value against the envelope contract and returns a
// discriminated result rather than throwing, because both consumers report the failure to a person:
// the CLI prints it, the Oracle renders it beside the input.
//
// The check is strict on identity (name, entry shape) and deliberately lenient on version, because
// rejecting an unrecognized app version would make the analyzer useless against the very logs most
// worth inspecting - those from a build that is ahead of it. Unknown versions analyze, with a
// warning attached, rather than being refused.
export function parseTapooLogExport(value: unknown): LogParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {ok: false, error: "Expected a Tapoo log export object at the top level."};
  }

  const envelope = value as Record<string, unknown>;

  if (envelope.name !== LOG_ENVELOPE_NAME) {
    return {
      ok: false,
      error: `Not a Tapoo log export: expected name "${LOG_ENVELOPE_NAME}", found ${JSON.stringify(envelope.name) ?? "nothing"}.`,
    };
  }

  if (!Array.isArray(envelope.entries)) {
    return {ok: false, error: "Tapoo log export is missing its `entries` array."};
  }

  const warnings: LogWarning[] = [];
  if (envelope.mode !== AGENT_API_MODE) {
    // Inaccurate rather than incomplete: every question is written for an agent-api round, so answering
    // them about some other mode produces verdicts, not correct ones.
    warnings.push({
      impact: "inaccurate",
      message: `Export mode is ${JSON.stringify(envelope.mode)}, not "${AGENT_API_MODE}". The behavior rubric only describes agent-api rounds.`,
    });
  }

  if (typeof envelope.version !== "string") {
    // Incomplete, not inaccurate: every verdict still stands, but the report cannot say which build
    // produced the behavior it describes, which is half of what makes it citable.
    warnings.push({
      impact: "incomplete",
      message: "Export carries no Tapoo version; results cannot be attributed to a build.",
    });
  }

  const entries = envelope.entries.filter(isLogEntry);
  const skipped = envelope.entries.length - entries.length;
  if (skipped > 0) {
    // Unreadable entries are stand-ins written by storage-logs.ts when a record fails to decode.
    // They are dropped rather than fatal: the surrounding round is still worth analyzing, but the
    // count has to surface, because it bounds how complete any "not observed" answer really is.
    warnings.push({
      // Inaccurate: the rubric answers NO on absent evidence, so evidence that was dropped rather than
      // never recorded can turn a YES into a NO without anything else looking wrong.
      impact: "inaccurate",
      message:
        skipped === 1
          ? "1 entry did not match the log entry shape and was skipped."
          : `${skipped} entries did not match the log entry shape and were skipped.`,
    });
  }

  if (entries.length === 0) {
    return {ok: false, error: "Tapoo log export contains no readable entries."};
  }

  // The same pass that validated the entries describes them: what the log contains, and where each
  // turn starts and ends. Every later reader indexes into this instead of walking the array again.
  const index = indexLog(entries);

  warnings.push(...unreadableResponseWarnings(entries));
  warnings.push(...encodedMazeWarnings(entries));

  // Neither unknownEvents nor levelDisagreements is reported here, deliberately.
  //
  // These warnings reach the reader under "Read with care", which is for caveats about the *log* - a
  // non-agent-api mode, a missing build version, entries that did not decode - things that genuinely
  // bound how much the verdicts are worth. An event the rubric has no question for is a gap in this
  // code, and a level contradicting its own payload is a bug in the producer. Neither is something a
  // reader can act on, and showing them there asks someone to distrust a report over an unimplemented
  // feature.
  //
  // The right home for "this event is not scored" is a fact question that scores it. Until there is
  // one, both stay available on the index for tests and for whoever adds that question - which is how
  // the two unscored events in a real glm-5.1 log were found in the first place.

  const log: TapooLog = {
    name: envelope.name,
    version: typeof envelope.version === "string" ? envelope.version : null,
    mode: typeof envelope.mode === "string" ? envelope.mode : null,
    downloadedAt: typeof envelope.downloadedAt === "string" ? envelope.downloadedAt : null,
    entries,
    index,
  };

  return {ok: true, value: log, warnings};
}

// parseTapooLogText is the raw JSON ingress point shared by the app and non-UI callers. Its successful
// output is the normalized Tapoo log shape every downstream query uses: name, version, mode,
// downloadedAt, and readable entries.
// unreadableResponseWarnings reports responses whose body this contract could not read at all.
//
// This is the check that was missing when it was needed most. A log of 1,459 entries analyzed to zero
// predictions and zero turns because every response was written in a provider shape the contract did
// not know, and nothing said so: each one was counted as an "empty response", which is a thing that
// legitimately happens, and 719 of them in a row looked no different from 719 quiet failures.
//
// The signal is precise rather than heuristic. Across every real log to hand - Ollama and OpenAI,
// 1,744 responses - not one has an unreadable *shape*; the 49 blank ones all have a readable message
// holding no text, which is a model stopping early and not a contract gap. So a single unreadable body
// means a shape this file does not handle, and that is worth saying on the first occurrence.
//
// Inaccurate, not incomplete: the rubric answers NO on absent evidence, so a prediction that was made
// but could not be read turns a YES into a NO. The verdicts are wrong, not merely fewer.
function unreadableResponseWarnings(entries: LogEntry[]): LogWarning[] {
  const responses = entries.filter((entry) => entry.payload === LOG_EVENTS.response);
  const unreadable = responses.filter((entry) => {
    const details = entry.details;
    const payload = details !== null && typeof details === "object" && "payload" in details
      ? details.payload
      : null;
    return assistantMessage(payload) === null;
  }).length;

  if (unreadable === 0) {
    return [];
  }

  const all = unreadable === responses.length;
  return [{
    impact: "inaccurate",
    message:
      `${unreadable} of ${responses.length} model ${responses.length === 1 ? "response" : "responses"} ` +
      `could not be read: the body is not in a shape this analyzer recognises. ` +
      `${all ? "No prediction in this log was scored" : "Those turns were not scored"}, so a capability ` +
      "answered NO may only mean the evidence for it was unreadable.",
  }];
}

// encodedMazeWarnings validates the encoded maze each level-started entry should carry.
//
// This belongs with the rest of the contract validation rather than downstream in the view: whether a
// payload in this JSON is present and well-formed is the same question as whether the envelope has a
// mode or an entry has a payload, and it is answered once, here, on the way in.
//
// Validation is also what decides the impact, because it is what knows the difference:
//
//   absent  -> incomplete. The log never carried a maze. Nothing is wrong; a section is missing.
//   invalid -> inaccurate. A payload was provided and it is not what it claims to be - a structure
//              that fails its own checksum arrived damaged, and "damaged" is a statement about the
//              data's accuracy, not about how much of it there is.
//
// Either way the rubric verdicts stand: no question reads this payload. The corridor questions answer
// from the exits the log's own tool results confirmed.
function encodedMazeWarnings(entries: LogEntry[]): LogWarning[] {
  const warnings: LogWarning[] = [];

  for (const entry of entries) {
    if (entry.payload !== LOG_EVENTS.levelStarted) continue;

    const details = entry.details;
    const maze = details !== null && typeof details === "object" && "maze" in details
      ? details.maze
      : null;
    const round = `Game ${entry.game ?? "?"} level ${entry.level ?? "?"}`;
    const cost = "so it has no traversal replay and no maze statistics";

    if (maze === null || maze === undefined) {
      warnings.push({
        impact: "incomplete",
        message: `${round} carries no encoded maze, ${cost}.`,
      });
      continue;
    }

    const built = mazeFromEncoded(maze as EncodedMaze);
    if (!built.ok) {
      warnings.push({
        impact: "inaccurate",
        message: `${round} carries an encoded maze that did not decode, ${cost}. ${built.error}`,
      });
    }
  }

  return warnings;
}

export function parseTapooLogText(text: unknown, {sourceUrl}: {sourceUrl?: string} = {}): LogTextResult {
  const trimmed = asTrimmedText(text);
  if (!trimmed) {
    return {ok: false, error: "Load a Tapoo agent-api log from an online JSON URL to begin."};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`};
  }

  const result = parseTapooLogExport(parsed);
  if (!result.ok) {
    return {ok: false, error: result.error};
  }

  return {
    ok: true,
    source: sourceUrl ? {...result.value, sourceUrl} : result.value,
    warnings: result.warnings,
  };
}
