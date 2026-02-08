/**
 * Fetch Cloudflare Worker logs for debugging the Open-Inspect control plane.
 *
 * Uses the Workers Observability Telemetry Query API to search historical logs
 * by session ID, Cloudflare request ID, trace ID, or free-text search.
 *
 * Usage:
 *   node --experimental-strip-types scripts/cf-logs.ts --session <session-id>
 *   bun scripts/cf-logs.ts --session <session-id>
 *
 * Combine filters:
 *   bun scripts/cf-logs.ts --session abc123 --search "sandbox"
 *   bun scripts/cf-logs.ts --session abc123 --level error
 *
 * Copy for LLM debugging:
 *   bun scripts/cf-logs.ts --session abc123 --json | pbcopy
 *
 * Environment variables required:
 *   CLOUDFLARE_API_TOKEN  - API token with Workers:Read permission
 *   CLOUDFLARE_ACCOUNT_ID - Your Cloudflare account ID
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TelemetryFilter {
  key: string;
  operation: string;
  type: string;
  value: string;
}

interface TelemetryQuery {
  view: string;
  queryId: string;
  limit: number;
  parameters: { filters: TelemetryFilter[] };
  timeframe: { from: number; to: number };
}

interface WorkersMetadata {
  id?: string;
  requestId?: string;
  traceId?: string;
  trigger?: string;
  service?: string;
  level?: string;
  message?: string;
  account?: string;
  type?: string;
  fingerprint?: string;
  origin?: string;
  messageTemplate?: string;
}

interface WorkersInfo {
  truncated?: boolean;
  event?: Record<string, unknown>;
  outcome?: string;
  scriptName?: string;
  eventType?: string;
  executionModel?: string;
  scriptVersion?: { id: string };
  durableObjectId?: string;
  requestId?: string;
  cpuTimeMs?: number;
  wallTimeMs?: number;
}

/** Application-level fields emitted by our logger via console.log(JSON.stringify(...)). */
interface LogSource {
  level?: string;
  service?: string;
  component?: string;
  msg?: string;
  message?: string;
  ts?: number;
  session_id?: string;
  request_id?: string;
  trace_id?: string;
  [key: string]: unknown;
}

/**
 * A single event from the Cloudflare Workers Observability Telemetry API.
 *
 * Two event types:
 *  - cf-worker-event ($metadata.type): platform-level request/response summary
 *  - cf-worker ($metadata.type): application-level log from console.log
 *
 * Application fields live under `source`, NOT at the top level.
 */
interface LogEvent {
  $metadata?: WorkersMetadata;
  $workers?: WorkersInfo;
  source?: LogSource;
  dataset?: string;
  timestamp?: number;
  links?: unknown[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const eqArg = args.find((a) => a.startsWith(prefix));
  if (eqArg) return eqArg.slice(prefix.length);

  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

const sessionId = getFlag("session");
const requestId = getFlag("request-id");
const traceId = getFlag("trace");
const searchText = getFlag("search");
const levelFilter = getFlag("level");
const scriptName = getFlag("script");
const mins = parseFloat(getFlag("mins") || "30"); // Default 30 minutes
const limit = parseInt(getFlag("limit") || "1000", 10);
const jsonOutput = hasFlag("json");
const showHelp = hasFlag("help") || hasFlag("h");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const fetchAll = hasFlag("all");

if (showHelp || (!sessionId && !requestId && !traceId && !searchText && !scriptName && !fetchAll)) {
  const prog = "scripts/cf-logs.ts";
  console.error(`Usage: ${prog} [filters] [options]`);
  console.error("");
  console.error("Filters (at least one required):");
  console.error("  --session <id>      Search by application session ID");
  console.error("  --request-id <id>   Search by request ID ($metadata.requestId: app-level");
  console.error("                      request_id on fetch events, CF platform ID on DO events)");
  console.error("  --trace <id>        Search by trace ID ($metadata.traceId, fetch events only)");
  console.error("  --search <text>     Free-text search on log messages ($metadata.message)");
  console.error("  --script <name>     Filter by worker script name");
  console.error("  --all               Fetch all logs (use with --mins to limit scope)");
  console.error("");
  console.error("Options:");
  console.error("  --level <level>     Filter by log level (debug, info, warn, error)");
  console.error("  --mins <N>         Look back N minutes (default: 30, max 10080 / 7 days)");
  console.error("  --limit <N>         Max events to return (default: 1000)");
  console.error("  --json              Output raw JSON (pipe to pbcopy for LLM debugging)");
  console.error("  --help              Show this help message");
  console.error("");
  console.error("Environment variables:");
  console.error("  CLOUDFLARE_API_TOKEN   API token with Workers:Read permission");
  console.error("  CLOUDFLARE_ACCOUNT_ID  Your Cloudflare account ID");
  console.error("");
  console.error("Examples:");
  console.error(`  bun ${prog} --session abc123`);
  console.error(`  bun ${prog} --session abc123 --level error`);
  console.error(`  bun ${prog} --request-id 9b9b9937bc6dc65e --json | pbcopy`);
  console.error(`  bun ${prog} --search "sandbox.create" --mins 30`);
  console.error(`  bun ${prog} --session abc123 --script open-inspect-control-plane`);
  process.exit(showHelp ? 0 : 1);
}

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("Error: Missing required environment variables");
  console.error("  CLOUDFLARE_ACCOUNT_ID:", ACCOUNT_ID ? "set" : "MISSING");
  console.error("  CLOUDFLARE_API_TOKEN:", API_TOKEN ? "set" : "MISSING");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Terminal colors
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  green: "\x1b[32m",
} as const;

function color(text: string, c: string): string {
  return useColor ? `${c}${text}${C.reset}` : text;
}

function levelColor(level: string | undefined): string {
  switch (level?.toLowerCase()) {
    case "error":
      return C.red;
    case "warn":
      return C.yellow;
    case "info":
      return C.blue;
    case "debug":
      return C.gray;
    default:
      return C.cyan;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTimestamp(ts: number | undefined): string {
  if (!ts) return "";
  return new Date(ts).toISOString().replace("T", " ").replace("Z", "");
}

function truncate(str: string, maxLen = 200): string {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/**
 * Format a single log entry for terminal display.
 *
 * Cloudflare Workers Observability events have this shape:
 *   { source, $metadata, $workers, timestamp, dataset, links }
 *
 * Application fields from our logger live under `source`:
 *   source.level, source.service, source.component, source.msg, source.ts,
 *   plus context fields (source.session_id, source.trace_id, etc.).
 *
 * Platform-level events (cf-worker-event) have minimal source:
 *   source.level, source.message (the request URL).
 */
function formatLogEntry(entry: LogEvent): string {
  const meta = entry.$metadata || {};
  const workers = entry.$workers || {};
  const src = entry.source || {};

  const timestamp = formatTimestamp(entry.timestamp);
  const level = (src.level || meta.level || "log").toUpperCase().padEnd(5);
  const component = src.component || "";
  const service = src.service || meta.service || workers.scriptName || "";
  // Our logger uses `msg`, CF platform events use `message`
  const message = src.msg || src.message || meta.message || "";

  const parts = [
    color(timestamp, C.dim),
    color(level, levelColor(src.level || meta.level)),
    service ? color(`[${service}]`, C.magenta) : "",
    component ? color(`(${component})`, C.cyan) : "",
    message,
  ].filter(Boolean);

  let output = parts.join(" ");

  // Show additional context fields from source
  const skipSourceKeys = new Set(["level", "service", "component", "msg", "message", "ts"]);
  const contextKeys = Object.keys(src).filter((k) => !skipSourceKeys.has(k));

  if (contextKeys.length > 0) {
    const context = contextKeys
      .map((k) => {
        const val = src[k];
        const str = typeof val === "object" ? JSON.stringify(val) : String(val);
        return `${k}=${truncate(str, 100)}`;
      })
      .join(" ");
    if (context) {
      output += ` ${color("|", C.gray)} ${color(context, C.gray)}`;
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// API query
// ---------------------------------------------------------------------------

function buildFilters(): TelemetryFilter[] {
  const filters: TelemetryFilter[] = [];

  if (sessionId) {
    filters.push({
      key: "session_id",
      operation: "eq",
      type: "string",
      value: sessionId,
    });
  }

  if (requestId) {
    filters.push({
      key: "$metadata.requestId",
      operation: "eq",
      type: "string",
      value: requestId,
    });
  }

  if (traceId) {
    filters.push({
      key: "$metadata.traceId",
      operation: "eq",
      type: "string",
      value: traceId,
    });
  }

  if (searchText) {
    // Use $metadata.message which is always populated (from source.msg or source.message)
    filters.push({
      key: "$metadata.message",
      operation: "includes",
      type: "string",
      value: searchText,
    });
  }

  if (levelFilter) {
    filters.push({
      key: "level",
      operation: "eq",
      type: "string",
      value: levelFilter.toLowerCase(),
    });
  }

  if (scriptName) {
    filters.push({
      key: "$workers.scriptName",
      operation: "eq",
      type: "string",
      value: scriptName,
    });
  }

  return filters;
}

async function fetchLogs(): Promise<LogEvent[]> {
  const now = new Date();
  const from = new Date(now.getTime() - mins * 60 * 1000);

  const query: TelemetryQuery = {
    view: "events",
    queryId: `cf-logs-${Date.now()}`,
    limit,
    parameters: {
      filters: buildFilters(),
    },
    timeframe: {
      from: from.getTime(),
      to: now.getTime(),
    },
  };

  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(query),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText}\n${text}`);
  }

  const data = (await response.json()) as {
    success: boolean;
    errors?: unknown[];
    result?: { events?: { events?: LogEvent[] } };
  };

  if (!data.success) {
    throw new Error(`API error: ${JSON.stringify(data.errors)}`);
  }

  return data.result?.events?.events || [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Build a description of active filters for the status line
  const filterDesc = [
    sessionId && `session=${sessionId}`,
    requestId && `requestId=${requestId}`,
    traceId && `trace=${traceId}`,
    searchText && `search="${searchText}"`,
    levelFilter && `level=${levelFilter}`,
    scriptName && `script=${scriptName}`,
  ]
    .filter(Boolean)
    .join(", ");

  console.error(color(`Fetching logs: ${filterDesc} (last ${mins}m, limit ${limit})...`, C.dim));

  try {
    const logs = await fetchLogs();

    if (logs.length === 0) {
      console.error(color("No logs found matching filters", C.yellow));
      console.error(
        color(
          "Tip: If querying by session_id or trace_id returns nothing, the field path may differ. " +
            "Try --request-id with a known CF request ID first to inspect the event shape with --json.",
          C.dim
        )
      );
      process.exit(0);
    }

    // Sort by timestamp ascending
    logs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    console.error(color(`Found ${logs.length} log entries\n`, C.dim));

    if (jsonOutput) {
      console.log(JSON.stringify(logs, null, 2));
    } else {
      for (const entry of logs) {
        console.log(formatLogEntry(entry));
      }
    }

    // Summary on stderr (doesn't interfere with piping)
    const first = logs[0] || {};
    const last = logs[logs.length - 1] || {};

    const levels: Record<string, number> = {};
    const components = new Set<string>();
    const execModels = new Set<string>();
    const scriptNames = new Set<string>();
    const outcomes = new Set<string>();
    const sessions = new Set<string>();

    for (const entry of logs) {
      const src = entry.source || {};
      const lvl = (src.level || entry.$metadata?.level || "unknown").toLowerCase();
      levels[lvl] = (levels[lvl] || 0) + 1;
      if (src.component) components.add(src.component);
      if (src.session_id) sessions.add(src.session_id);
      const w = entry.$workers || {};
      if (w.executionModel) execModels.add(w.executionModel);
      if (w.scriptName) scriptNames.add(w.scriptName);
      if (w.outcome) outcomes.add(w.outcome);
    }

    console.error("");
    console.error(color("--- Summary ---", C.dim));
    console.error(color(`  Script:     ${[...scriptNames].join(", ") || "unknown"}`, C.dim));
    console.error(color(`  Entries:    ${logs.length}`, C.dim));
    console.error(
      color(
        `  Levels:     ${Object.entries(levels)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`,
        C.dim
      )
    );
    if (components.size > 0) {
      console.error(color(`  Components: ${[...components].join(", ")}`, C.dim));
    }
    if (sessions.size > 0) {
      console.error(color(`  Sessions:   ${[...sessions].join(", ")}`, C.dim));
    }
    if (execModels.size > 0) {
      console.error(color(`  Exec model: ${[...execModels].join(", ")}`, C.dim));
    }
    console.error(color(`  From:       ${formatTimestamp(first.timestamp)}`, C.dim));
    console.error(color(`  To:         ${formatTimestamp(last.timestamp)}`, C.dim));
    if (outcomes.size > 0) {
      console.error(color(`  Outcomes:   ${[...outcomes].join(", ")}`, C.dim));
    }
  } catch (error) {
    console.error(color(`Error: ${(error as Error).message}`, C.red));
    process.exit(1);
  }
}

main();
