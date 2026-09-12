// Turning a report into what the page shows: cards, rows, and sentences.
//
// Nothing here invents a number. Every value traces to a rubric answer or to a field the log states
// outright, which is why the adapters are pure and testable without a DOM.

import { agentSeatLabel } from "./log-contract"
import type { AgentSummary, LogWarning, GroupKind, GroupResult, Report, SummaryRow, TapooLog, ValidationCheck } from "./types"
import { capitalize, formatCount } from "./utils"

/** warningHeadline is the sentence a reader sees in bold above the caveats, or null when there are none.
 *
 * A warning is only shown when it costs the reader something, so the banner says what that cost is
 * rather than asking them to work it out from a list. A heading like "Read with care" sets a tone
 * instead of stating a finding, and leaves a reader unable to tell whether a verdict below is wrong or
 * the report is merely missing its provenance.
 *
 * The two impacts are reported together when both are present, because they are different harms and
 * collapsing them would understate one of them. */
export function warningHeadline(warnings: LogWarning[]): string | null {
  const inaccurate = warnings.some((warning) => warning.impact === "inaccurate")
  const incomplete = warnings.some((warning) => warning.impact === "incomplete")

  if (inaccurate && incomplete) return "This report may be inaccurate and is missing important parts."
  if (inaccurate) return "This report may be inaccurate."
  if (incomplete) return "This report is missing important parts."
  return null
}

/** profileCards: the two fractions, each naming the groups it counted.
 *
 * Two fractions, never one. The rubric is explicit that capabilities and violations must not collapse
 * into a single score interval: a model with six capabilities and two violations is not "four", and any
 * arithmetic producing one number here would invent a scale the contract deliberately refuses to define.
 *
 * The groups are named in full, with their code in parentheses - "Multi-step execution (C6)" - rather
 * than left as a row of codes. A card reading "5/9 (C2, C3, C6, C8, C9)" looks informative and is not:
 * the reader has to carry five codes down to the rubric tables and match them there to learn what was
 * actually demonstrated. Hovering was the cheaper fix and it is not one, because a hover does not exist
 * on touch and nothing about a code invites the attempt.
 *
 * The cost is height - five names is three lines where five codes was one - and it is paid in the one
 * place on the page where the reader is deciding what this agent did.
 *
 * Returned as pairs rather than as a formatted string: how they are joined is the view's business, and
 * the test can then assert on the groups themselves rather than on punctuation. */
/** One capability group named on a card: its rubric id and the name a reader reads. */
export type ProfileCardGroup = {id: string; label: string};

/** One profile card: its heading, the `met/total` it scored, the groups it met, and the tone the view
 * paints it in. */
export type ProfileCard = {label: string; value: string; groups: ProfileCardGroup[]; tone: string};

export function profileCards(report: Report): ProfileCard[] {
  const card = (label: string, groups: GroupResult[], tone: string) => {
    const met = groups.filter((group) => group.met);
    return {
      label,
      value: `${met.length}/${groups.length}`,
      // Empty when nothing was met, so the view can drop the list entirely: "Violations confirmed 0/6,
      // none" states the same zero twice.
      groups: met.map((group) => ({id: group.id, label: group.label})),
      tone,
    };
  };

  return [
    card("Capabilities demonstrated", report.capabilities, "teal"),
    card("Violations confirmed", report.violations, "rose"),
  ];
}

/** narrativeSummary states, in a sentence, only what nothing else on the page says.
 *
 * Which rules out most of what a summary is tempted to say. What a NO means is the method, and
 * "How this report is generated" states it. The model, the provider and the effort belong to a seat, and
 * the Agents table gives each its own row - a sentence naming one of them speaks for a round that may
 * have seated two. The capability fraction is on the profile cards directly beneath, as 5/9.
 *
 * What is left is the prediction count and the winning speed, which no card and no table carries. */
export function narrativeSummary(report: Report): string {
  const speed =
    report.traversalSpeedClass !== null && Number.isFinite(report.traversalSpeed)
      ? `Winning traversal speed ${(report.traversalSpeed as number).toFixed(4)} (${report.traversalSpeedClass}).`
      : "No winning round in this sample.";

  return [
    `${formatCount(report.predictions)} prediction${report.predictions === 1 ? "" : "s"}.`,
    speed,
  ].join(" ");
}

/** groupResultTone names the class a group result should carry, or null for no colour at all.
 *
 * Split out from the table's format callback because this is the part that can be wrong: YES means
 * opposite things in the two tables, and the rule for what stays uncoloured is a statement about
 * what the rubric claims. The span-wrapping around it cannot be, so the DOM stays in the view and
 * the decision stays here where the suite can reach it. */
export function groupResultTone(kind: GroupKind, groupResult: string): string | null {
  // NO is never coloured. For a violation it is the good outcome, and for a capability it means the
  // behavior was not observed in this sample - never that the model is incapable of it, which is the
  // one thing this report exists not to say. Red on that line would say it.
  if (!String(groupResult).startsWith("YES")) {
    return null
  }

  return kind === "violation" ? "result-confirmed" : "result-demonstrated"
}

/** rubricQuestionRows gives every evaluated fact its own row. Group verdicts and fractions remain
 * visible because a partially evidenced group and a group with no evidence can share the same NO. */
export function rubricQuestionRows(groups: GroupResult[]): Array<Record<string, string>> {
  return groups.flatMap((group) =>
    Object.entries(group.answers).map(([questionId, answer]) => ({
      id: `${group.id}.${questionId}`,
      group: group.label,
      question: group.questions[questionId] ?? "",
      answer: answer ? "YES" : "NO",
      groupResult: `${group.met ? "YES" : "NO"} (${group.passed}/${group.total})`,
    })),
  )
}

/** diagnosticRows reports operational signals, some of which the violation profile deliberately excludes.
 *
 * Named by what was counted and at which layer, because three of them would otherwise all be "responses"
 * and two would both be "failures". A request that never came back is not the same event as an answer that
 * came back empty, and a reader comparing two runs has to be able to tell which moved:
 *
 *   Failed requests, Harness faults - nothing reached the model, or nothing came back. Never scored: a
 *   provider outage is not the model's reasoning, and a fault in Tapoo's own tooling is even less so.
 *
 *   Empty answers, Malformed predictions, Token cap hits - the model answered, and the answer is the
 *   problem. Each of these has a rubric question behind it.
 *
 *   Times disabled - the round stopped. It bounds what every figure beside it covers. */
/** One diagnostics line: what went wrong, how often, and the rubric question that scores it - null
 * when nothing does. */
export type DiagnosticRow = {signal: string; count: number; scoredBy: string | null};

export function diagnosticRows(report: Report): DiagnosticRow[] {
  // scoredBy is the rubric question this signal answers, or null when nothing scores it. A nullable id
  // rather than a display string: "no" and "V2.Q2" sat in one field, so the only way to tell a code
  // from a word was to look at the characters. The distinction is knowledge this table already has.
  return [
    {signal: "Failed requests", count: report.diagnostics.endpointFailures, scoredBy: null},
    {signal: "Harness faults", count: report.diagnostics.harnessFailures, scoredBy: null},
    {signal: "Empty answers", count: report.diagnostics.emptyResponses, scoredBy: "V2.Q2"},
    {signal: "Malformed predictions", count: report.diagnostics.unparseableResponses, scoredBy: "V2.Q1"},
    {signal: "Token cap hits", count: report.diagnostics.tokenExhaustions, scoredBy: "V5.Q3"},
    {signal: "Times disabled", count: report.diagnostics.agentDisablings, scoredBy: null}
  ];
}

/** Shapes diagnostics as one signal per row, with its count and scoring question in separate columns. */
export function diagnosticTableData(report: Report): {columns: string[]; rows: Array<Record<string, unknown>>} {
  return {
    columns: ["measure", "count", "scoredBy"],
    rows: diagnosticRows(report).map((row) => ({
      measure: row.signal,
      count: row.count,
      scoredBy: row.scoredBy ?? "-",
    })),
  }
}


/** modelOutputRows summarises what the model produced, as the provider itself reported it.
 *
 * Only rows the provider actually reported: the two APIs report overlapping but different things, and
 * a row reading "not recorded" for every Ollama log would be a column of noise rather than a finding.
 * The exception is the token counts, which both report and which are the point of the section.
 *
 * Nothing here is scored. It is context for reading the verdicts above - a model given 3,000 prompt
 * tokens per turn and one given 300 are not doing the same task, and neither is a run that spent most
 * of its completion budget on reasoning tokens. */
export function modelOutputRows(report: Report): SummaryRow[] {
  const {output} = report;
  const rows: SummaryRow[] = [
    {field: "Responses", value: formatCount(output.responses)},
  ];

  const tokens = (label: string, total: number | null): void => {
    if (total === null) return;
    // Per response as well as in total: a total is a function of how long the run was, and the average
    // is what compares one run to another.
    const each = output.responses > 0 ? Math.round(total / output.responses) : 0;
    rows.push({field: label, value: `${formatCount(total)} (${formatCount(each)} per response)`});
  };

  tokens("Prompt tokens", output.promptTokens);
  tokens("Completion tokens", output.completionTokens);
  tokens("Reasoning tokens", output.reasoningTokens);
  tokens("Cached prompt tokens", output.cachedPromptTokens);

  if (output.finishReasons.length > 0) {
    // Named and counted rather than reduced to the most common one: "length" appearing at all means the
    // model was cut off mid-answer, and that is worth seeing even when it happened three times in 719.
    rows.push({
      field: "Finish reasons",
      value: output.finishReasons.map(([reason, count]) => `${reason} (${formatCount(count)})`).join(", "),
    });
  }

  return rows;
}

/** provenanceRows describe which build and which round produced the log, so a profile is never read
 * detached from what it was measured against.
 *
 * Only what belongs to the file and the round. A model, a provider, an effort and a player describe a
 * *seat* instead, and a round can seat more than one, so those live per seat - see agentRows. */
export function provenanceRows(source: TapooLog): SummaryRow[] {
  return [
    // No source URL row. It is the one field here that is not read out of the log itself, the panel
    // above already carries the share link that identifies the same log, and a table cell is the
    // most screenshotted place on the page to put an address that the rest of this change exists to
    // keep out of it. What remains is provenance the log vouches for.
    {field: "Tapoo version", value: source.version ?? "not recorded"},
    {field: "Platform", value: source.platform ?? "not recorded"},
    {field: "Device", value: source.device ?? "not recorded"},
    {field: "Downloaded at", value: source.downloadedAt ?? "not recorded"},
    {field: "Log entries", value: formatCount(source.entries.length)},
    {field: "Control mode", value: source.mode ?? "not recorded"},
  ];
}

/** Strips any userinfo from an endpoint before it is rendered.
 *
 * The endpoint is an address, and this file already keeps one out of the DOM - see the note above about
 * a table cell being the most screenshotted place on the page. This address is wanted, a reader cannot
 * compare two runs without knowing where each was answered, but `user:pass@host` must not be. Silent on
 * a value that does not parse: an endpoint the URL constructor rejects carries no userinfo to strip.
 */
export function withoutCredentials(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (!url.username && !url.password) return endpoint;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return endpoint;
  }
}

/** The values one seat was running, each already rendered for reading - names capitalized, lists
 * joined, credentials stripped - and each "" where the round stated none.
 *
 * Kept unjoined beside the sentence built from them because these four are the whole of what a reader
 * comparing two seats compares, and a view that can weight them differently should not have to take the
 * sentence apart again to find them. */
export type AgentRunning = {
  models: string[];
  /** The API families the request was made in - "Ollama", "OpenAI" - which is a wire protocol and not the
   * company that served the model. Hugging Face has no API of its own and answers on OpenAI's, so a seat
   * running there reports "OpenAI" here and names Hugging Face only in its endpoint. Printing this as
   * the provider read as a claim about who ran the model, which this field does not make. */
  api: string[];
  endpoint: string[];
  effort: string[];
  /** Whether the harness echoed the model's reasoning back to it, and how long it waited between
   * requests. Both are stated from v2.6.1 and empty before it, so a row on an older log simply does not
   * mention them - which is the honest rendering of a setting the log never named. */
  echo: string[];
  interval: string[];
};

/** CHANGED_JOIN separates the values of a setting a seat did not hold still.
 *
 * An arrow rather than a comma, and in first-seen order, which is the order the turns ran in: a comma
 * makes two models read as a list, and at a glance as one long name. The whole point of this cell is
 * that a seat which changed setup mid-round is the finding agentSettingsCheck reports, so the cell has
 * to look different from a clean one before it is read rather than after. */
export const CHANGED_JOIN = " \u2192 ";

/** One seat's row: the sentence to read, and the values it was built from. */
export type AgentRow = {
  field: string;
  value: string;
  running: AgentRunning;
};

/** How an API family's own name is written, for the few this analyzer has seen.
 *
 * `capitalize` alone gets "Openai", and these are proper names with fixed spellings. Anything unlisted
 * falls back to it: a new value is better shown miscased than dropped, and the log is the authority on
 * which families exist. */
const API_NAMES: Record<string, string> = {
  ollama: "Ollama",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

const apiName = (api: string): string => API_NAMES[api.toLowerCase()] ?? capitalize(api);

/** agentRows says what each seat was running, one row per seat.
 *
 * Two columns, not five, for the reason Provenance is two as well: a column per fact trims its own
 * values on a narrow viewport, and an endpoint is the widest value on the page.
 * The seat is the row's name and the rest reads as a sentence, so a two-seat round is two lines rather
 * than a grid to scan across. */
export function agentRows(agents: AgentSummary[]): AgentRow[] {
  return agents.map((agent, index) => {
    const running: AgentRunning = {
      models: agent.models,
      api: agent.apis.map(apiName),
      endpoint: agent.endpoints.map(withoutCredentials),
      effort: agent.reasoningEfforts,
      echo: agent.echoBackReasoning,
      interval: agent.requestIntervalSeconds.map((seconds) => `${seconds} sec`),
    };

    // The sentence joins the same way the cell does, so the fallback and what a reader sees say the same
    // thing about whether a setting moved.
    const said = (values: string[]): string => values.join(CHANGED_JOIN);
    const sentence = [
      running.models.length > 0 ? said(running.models) : "not recorded",
      running.api.length === 0 ? "" : `on the ${said(running.api)} API`,
      running.effort.length === 0 ? "" : `at ${said(running.effort)} reasoning effort`,
      running.echo.length === 0 ? "" : `(echo back reasoning: ${said(running.echo)})`,
      running.endpoint.length === 0 ? "" : said(running.endpoint),
      running.interval.length === 0 ? "" : `(polling rate: ${said(running.interval)})`,
    ].filter((part) => part !== "");

    return {field: agentSeatLabel(agent, index), value: sentence.join(" "), running};
  });
}


/** The mark a file-wide check carries, and the note that explains it. */
export const LOG_SCOPE_MARK = "*";

/** The order the validation table reads in, whatever order the checks were built in.
 *
 * A narrative, not a grouping. The file first - could these entries be read at all, and could the model's
 * answers be read out of them - then the maze the round was played on, then what the agent was shown about
 * it, then who was playing and under what. A reader going down the column is following the pipeline that
 * produced the verdicts above the table.
 *
 * Declared here rather than left to construction order, because the checks are assembled in three separate
 * places - the envelope parse, the round parse, and the composition in roundReportFor - so the order a
 * reader sees would otherwise be an accident of where each one was appended, and a new check would land
 * wherever its author happened to push it.
 *
 * A name missing from this list sorts to the end rather than vanishing: an unlisted check is a check to
 * place, and a reader still sees it in the meantime. */
const CHECK_ORDER = [
  "Log entry fields",
  "Model responses",
  "Encoded maze",
  "Traversal payloads",
  "Prompts and tool descriptions",
  "Trimmed checksummed repeats",
  "Tool descriptions",
  "Agent personas",
  "User warnings",
  "Seat roster",
  "Agent settings",
];

const rank = (name: string): number => {
  const at = CHECK_ORDER.indexOf(name);
  return at === -1 ? CHECK_ORDER.length : at;
};

/** validationRows turns the checks an analyzer ran into rows a reader can scan.
 *
 * The outcome leads the value, not the name, so a column of results reads down: passed, passed,
 * not checked. It is the third that this table exists for: the checks raise warnings only on failure, so
 * without a table saying what ran, a clean page and an unchecked one look identical.
 *
 * "not checked" rather than "unchecked": the reader is being told what this analyzer did, and the
 * useful distinction is between a check that ran and one that could not.
 *
 * A file-wide check is marked rather than grouped. The reader has already chosen a round from the tabs
 * above, so splitting one short table under a second set of headings reads as a second choice to make;
 * an asterisk and one line of footnote says the same thing without asking anything of them. */
export function validationRows(checks: ValidationCheck[]): SummaryRow[] {
  const said = {passed: "passed", failed: "FAILED", unchecked: "not checked"};
  return [...checks]
    .sort((first, second) => rank(first.name) - rank(second.name))
    .map((check) => ({
      field: `${check.name}${check.scope === "log" ? LOG_SCOPE_MARK : ""}`,
      value: `${said[check.outcome]} - ${check.detail}`,
    }));
}
