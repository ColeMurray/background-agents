/**
 * Get Child Status Tool — check on child session progress.
 *
 * Dual-mode: omit childId to list all children, or provide one for details.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";
import {
  buildChildDetailQuery,
  formatChildDetail,
  formatStatus,
  formatTimestamp,
} from "./get-child-status-format.js";

async function listChildren() {
  const response = await bridgeFetch("/children");

  if (!response.ok) {
    const errorMessage = await extractError(response);
    return `Failed to list children: ${errorMessage} (HTTP ${response.status})`;
  }

  const { children } = await response.json();

  if (!children || children.length === 0) {
    return "No child sessions found.";
  }

  const counts = { pending: 0, running: 0, done: 0, failed: 0 };
  const lines = [];

  for (const child of children) {
    const label = formatStatus(child.status);
    if (label === "PENDING") counts.pending++;
    else if (label === "RUNNING") counts.running++;
    else if (label === "FAILED") counts.failed++;
    else counts.done++;

    lines.push(
      `  [${label}] ${child.id}`,
      `    Title: ${child.title || "(untitled)"}`,
      `    Created: ${formatTimestamp(child.createdAt)}`,
      ""
    );
  }

  const header = `${children.length} child session(s): ${counts.running} running, ${counts.pending} pending, ${counts.done} done, ${counts.failed} failed`;
  return [header, "", ...lines].join("\n");
}

async function getChildDetail(childId, options = {}) {
  const encodedChildId = encodeURIComponent(childId);
  const response = await bridgeFetch(
    `/children/${encodedChildId}${buildChildDetailQuery(options)}`
  );

  if (!response.ok) {
    if (response.status === 404) {
      return `Child "${childId}" not found. Use get-child-status without a childId to list all children.`;
    }
    const errorMessage = await extractError(response);
    return `Failed to get child: ${errorMessage} (HTTP ${response.status})`;
  }

  const detail = await response.json();
  return formatChildDetail(detail, childId, options);
}

export default tool({
  name: "get-child-status",
  description:
    "Check child session status only when its result is needed; do not poll repeatedly. Without a childId, lists all child sessions with summary counts. With a childId, returns details. Set includeResponse to retrieve the child's final assistant response when available. Set includeTrajectory for a paginated persisted event trajectory.",
  args: {
    childId: z
      .string()
      .optional()
      .describe("Specific child ID to get details for. Omit to list all child sessions."),
    includeResponse: z
      .boolean()
      .optional()
      .describe("Include the child's final assistant response when available."),
    includeTrajectory: z
      .boolean()
      .optional()
      .describe(
        "Include a persisted child event trajectory page. Use includeResponse separately to include the final response."
      ),
    trajectoryLimit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Maximum trajectory events to retrieve when includeTrajectory is true."),
    trajectoryCursor: z
      .string()
      .optional()
      .describe("Cursor returned by a previous trajectory page."),
    includeEventData: z
      .boolean()
      .optional()
      .describe("Include raw JSON payloads for each trajectory event."),
  },
  async execute(args) {
    try {
      if (args.childId) {
        return await getChildDetail(args.childId, {
          includeResponse: args.includeResponse,
          includeTrajectory: args.includeTrajectory || args.includeEventData,
          trajectoryLimit: args.trajectoryLimit,
          trajectoryCursor: args.trajectoryCursor,
          includeEventData: args.includeEventData,
        });
      }
      return await listChildren();
    } catch (error) {
      return `Failed to get child status: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
