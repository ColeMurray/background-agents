const STATUS_LABELS = {
  created: "PENDING",
  active: "RUNNING",
  completed: "DONE",
  failed: "FAILED",
  cancelled: "CANCELLED",
  archived: "DONE",
};

export function formatStatus(status) {
  return STATUS_LABELS[status] || status.toUpperCase();
}

export function formatTimestamp(ts) {
  if (!ts) return "n/a";
  return new Date(ts).toISOString();
}

export function indentBlock(text, indent = "    ") {
  return String(text)
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

export function formatEventData(data) {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function summarizeEvent(event) {
  const data = event?.data || {};
  const text =
    data.message ?? data.content ?? data.result ?? data.error ?? data.status ?? data.state ?? null;

  if (event.type === "tool_call") {
    const tool = data.tool || data.name || "tool";
    const args = data.args || {};
    const target = args.command || args.file_path || args.pattern;
    return target ? `${tool}: ${target}` : String(tool);
  }

  if (typeof text === "string" && text.length > 0) {
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  }

  return "";
}

export function buildChildDetailQuery(options = {}) {
  const include = [];
  if (options.includeResponse) {
    include.push("result");
  }
  if (options.includeTrajectory) {
    include.push("trajectory");
  }

  const params = new URLSearchParams();
  if (include.length > 0) {
    params.set("include", include.join(","));
  }
  if (options.includeTrajectory && options.trajectoryLimit) {
    params.set("trajectoryLimit", String(options.trajectoryLimit));
  }
  if (options.includeTrajectory && options.trajectoryCursor) {
    params.set("trajectoryCursor", options.trajectoryCursor);
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

export function formatArtifacts(artifacts = []) {
  if (artifacts.length === 0) return [];

  const lines = ["", "  Artifacts:"];
  for (const a of artifacts) {
    const label = a.type === "pr" ? `PR: ${a.url}` : `${a.type}: ${a.url}`;
    lines.push(`    - ${label}`);
  }
  return lines;
}

export function formatFinalResponse(finalResponse, includeResponse) {
  if (!finalResponse) {
    return includeResponse ? ["", "  Final response: not available yet"] : [];
  }

  const lines = ["", "  Final response:"];
  lines.push(`    Success: ${finalResponse.success ? "yes" : "no"}`);
  if (finalResponse.error) {
    lines.push(`    Error: ${finalResponse.error}`);
  }
  if (finalResponse.eventLimitReached) {
    lines.push(`    Events: ${finalResponse.eventCount} (limit reached)`);
  }
  lines.push("    Text:");
  lines.push(indentBlock(finalResponse.textContent || "(empty)", "      "));

  if (finalResponse.toolCalls?.length) {
    lines.push("", "    Tool summary:");
    for (const call of finalResponse.toolCalls) {
      lines.push(`      - ${call.summary || call.tool}`);
    }
  }

  return lines;
}

export function formatTrajectory(trajectory, options = {}) {
  if (!trajectory) return [];

  const suffix = trajectory.hasMore ? " (more available)" : "";
  const lines = ["", `  Trajectory${suffix}:`];
  if (!trajectory.events?.length) {
    lines.push("    (no events)");
  } else {
    for (const e of trajectory.events) {
      const time = formatTimestamp(e.createdAt);
      const message = e.messageId ? ` message=${e.messageId}` : "";
      const summary = summarizeEvent(e);
      lines.push(`    [${time}] ${e.type}${message}${summary ? `: ${summary}` : ""}`);
      if (options.includeEventData) {
        lines.push(`      ${formatEventData(e.data)}`);
      }
    }
  }

  if (trajectory.hasMore && trajectory.cursor) {
    lines.push(`    More events available. Re-run with trajectoryCursor="${trajectory.cursor}".`);
  }

  return lines;
}

export function formatRecentEvents(recentEvents = []) {
  if (recentEvents.length === 0) return [];

  const lines = ["", "  Recent events:"];
  for (const e of recentEvents) {
    const time = formatTimestamp(e.createdAt);
    const raw = e.data?.message || e.data?.content || e.type;
    const summary = typeof raw === "string" ? raw : JSON.stringify(raw);
    lines.push(`    [${time}] ${e.type}: ${summary.slice(0, 120)}`);
  }
  return lines;
}

export function formatChildDetail(detail, taskId, options = {}) {
  const s = detail.session || {};
  const lines = [
    `Task: ${s.id || taskId}`,
    `  Title:   ${s.title || "(untitled)"}`,
    `  Status:  ${formatStatus(s.status || "unknown")}`,
    `  Model:   ${s.model || "default"}`,
    `  Repo:    ${s.repoOwner || ""}/${s.repoName || ""}`,
    `  Branch:  ${s.branchName || "(none)"}`,
    `  Created: ${formatTimestamp(s.createdAt)}`,
    `  Updated: ${formatTimestamp(s.updatedAt)}`,
  ];

  if (detail.sandbox) {
    lines.push(`  Sandbox: ${detail.sandbox.status}`);
  }

  lines.push(...formatArtifacts(detail.artifacts));
  lines.push(...formatFinalResponse(detail.finalResponse, Boolean(options.includeResponse)));
  lines.push(...formatTrajectory(detail.trajectory, options));
  lines.push(...formatRecentEvents(detail.recentEvents));

  return lines.join("\n");
}
