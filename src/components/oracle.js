const EVENT_KEYS = new Set([
  "event",
  "events",
  "action",
  "actions",
  "step",
  "steps",
  "trace",
  "traces",
  "turn",
  "turns",
  "move",
  "moves",
  "observation",
  "observations",
  "prediction",
  "predictions",
  "decision",
  "decisions"
]);

const STATUS_KEYS = ["status", "outcome", "result", "state", "verdict"];
const ACTION_KEYS = ["action", "type", "event", "name", "tool", "operation", "kind"];
const AGENT_KEYS = ["agent", "agentId", "agent_id", "actor", "profile", "profileId", "profile_id", "model"];
const TIMESTAMP_KEYS = ["timestamp", "time", "createdAt", "created_at", "epochMs", "epoch_ms", "date"];

const SAMPLE_PAYLOAD = {
  runId: "tapoo-run-2026-08-30T14:12:00Z",
  source: "tapoo-agent-behavior-profiler",
  agent: "tapoo-agent",
  summary: {
    objective: "Evaluate navigation behavior under a constrained decision path"
  },
  turns: [
    {
      turn: 1,
      timestamp: "2026-08-30T14:12:01Z",
      action: "observe",
      status: "applied",
      visitedCells: ["A1"]
    },
    {
      turn: 2,
      timestamp: "2026-08-30T14:12:09Z",
      action: "move",
      status: "applied",
      visitedCells: ["A1", "B1"]
    },
    {
      turn: 3,
      timestamp: "2026-08-30T14:12:22Z",
      action: "backtracking",
      status: "applied",
      visitedCells: ["A1", "B1"]
    },
    {
      turn: 4,
      timestamp: "2026-08-30T14:12:34Z",
      action: "prediction",
      status: "warning",
      message: "Warning: partial path repeated without new evidence"
    }
  ]
};

export const samplePayloadText = JSON.stringify(SAMPLE_PAYLOAD, null, 2);

export function parsePayload(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return {ok: false, error: "Paste a Tapoo profiler JSON payload to begin."};

  try {
    return {ok: true, value: JSON.parse(trimmed)};
  } catch (error) {
    return {ok: false, error: error.message};
  }
}

export function analyzePayload(payload) {
  const events = collectEvents(payload);
  const statuses = countBy(events, (event) => normalizeValue(readFirst(event, STATUS_KEYS), "unknown"));
  const actionTypes = countBy(events, (event) => normalizeValue(readFirst(event, ACTION_KEYS), "event"));
  const agents = countBy(events, (event) => normalizeValue(readFirst(event, AGENT_KEYS), "unknown"));
  const timeline = events
    .map((event, index) => ({
      index: index + 1,
      timestamp: readTimestamp(event),
      action: normalizeValue(readFirst(event, ACTION_KEYS), "event"),
      status: normalizeValue(readFirst(event, STATUS_KEYS), "unknown"),
      summary: summarizeEvent(event)
    }))
    .filter((event) => event.timestamp instanceof Date && Number.isFinite(+event.timestamp));
  const warnings = events.filter((event) => hasWarning(event));
  const backtracking = events.filter((event) => JSON.stringify(event).toLowerCase().includes("backtracking"));

  return {
    payload,
    events,
    statuses,
    actionTypes,
    agents,
    timeline,
    warnings,
    backtracking,
    rootKeys: isRecord(payload) ? Object.keys(payload) : [],
    shape: Array.isArray(payload) ? "array" : typeof payload
  };
}

export function metricCards(analysis) {
  return [
    {label: "Profiler events", value: analysis.events.length.toLocaleString("en-US"), tone: "ink"},
    {label: "Action types", value: analysis.actionTypes.length.toLocaleString("en-US"), tone: "teal"},
    {label: "Warnings", value: analysis.warnings.length.toLocaleString("en-US"), tone: "amber"},
    {label: "Backtracking signals", value: analysis.backtracking.length.toLocaleString("en-US"), tone: "rose"}
  ];
}

export function narrativeSummary(analysis) {
  const topAction = analysis.actionTypes[0];
  const topStatus = analysis.statuses[0];
  const agent = analysis.agents[0]?.key;
  const warnings = analysis.warnings.length;
  const backtracking = analysis.backtracking.length;
  const fragments = [
    `Detected ${analysis.events.length.toLocaleString("en-US")} profiler event${analysis.events.length === 1 ? "" : "s"}`,
    agent && agent !== "unknown" ? `for ${agent}` : "from the submitted Tapoo payload",
    topAction ? `with "${topAction.key}" as the most common behavior` : "with no dominant behavior detected",
    topStatus ? `and "${topStatus.key}" as the most common status` : "and no status field detected"
  ];

  return `${fragments.join(" ")}. Warning signals: ${warnings.toLocaleString("en-US")}. Backtracking references: ${backtracking.toLocaleString("en-US")}.`;
}

export function tableRows(analysis, limit = 20) {
  return analysis.events.slice(0, limit).map((event, index) => ({
    "#": index + 1,
    action: normalizeValue(readFirst(event, ACTION_KEYS), "event"),
    status: normalizeValue(readFirst(event, STATUS_KEYS), "unknown"),
    agent: normalizeValue(readFirst(event, AGENT_KEYS), "unknown"),
    timestamp: formatTimestamp(readTimestamp(event)),
    detail: summarizeEvent(event)
  }));
}

export function formatDatumLabel(d) {
  return `${d.key}: ${d.value}`;
}

function collectEvents(payload) {
  const events = [];
  const seen = new WeakSet();

  visit(payload, "", 0);
  return events.length ? events : (isRecord(payload) ? [payload] : []);

  function visit(value, key, depth) {
    if (depth > 8 || value == null) return;

    if (Array.isArray(value)) {
      if (looksLikeEventCollection(key, value)) {
        for (const item of value) if (isRecord(item)) events.push(item);
      }
      for (const item of value) visit(item, key, depth + 1);
      return;
    }

    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);

    if (looksLikeEvent(value)) events.push(value);
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey, depth + 1);
  }
}

function looksLikeEventCollection(key, value) {
  return EVENT_KEYS.has(String(key).toLowerCase()) || value.some((item) => isRecord(item) && looksLikeEvent(item));
}

function looksLikeEvent(value) {
  const keys = Object.keys(value);
  return keys.some((key) => EVENT_KEYS.has(key.toLowerCase())) || keys.some((key) => STATUS_KEYS.includes(key) || ACTION_KEYS.includes(key));
}

function countBy(values, accessor) {
  const counts = new Map();
  for (const value of values) {
    const key = accessor(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts, ([key, value]) => ({key, value})).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

function readFirst(value, keys) {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    if (value[key] != null && value[key] !== "") return value[key];
  }
  return undefined;
}

function readTimestamp(value) {
  const raw = readFirst(value, TIMESTAMP_KEYS);
  if (typeof raw === "number") return new Date(raw > 10_000_000_000 ? raw : raw * 1000);
  if (typeof raw === "string" && raw.trim()) return new Date(raw);
  return undefined;
}

function formatTimestamp(value) {
  return value instanceof Date && Number.isFinite(+value) ? value.toISOString() : "";
}

function normalizeValue(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return fallback;
  return String(value);
}

function summarizeEvent(event) {
  const text = readFirst(event, ["summary", "message", "reason", "description", "error", "warning", "prompt"]);
  if (typeof text === "string" && text.trim()) return text.trim().slice(0, 180);

  const keys = Object.keys(event).filter((key) => !["visitedCells", "visited_cells", "path"].includes(key));
  return keys.slice(0, 6).map((key) => `${key}: ${formatPreview(event[key])}`).join(", ");
}

function formatPreview(value) {
  if (value == null) return "";
  if (typeof value === "object") return Array.isArray(value) ? `[${value.length}]` : "{...}";
  return String(value).slice(0, 48);
}

function hasWarning(value) {
  return JSON.stringify(value).toLowerCase().includes("warning");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
