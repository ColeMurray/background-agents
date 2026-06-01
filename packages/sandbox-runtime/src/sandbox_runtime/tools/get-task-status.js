/**
 * Get Task Status Tool — check on child task progress.
 *
 * Dual-mode: omit taskId to list all children, or provide one for details.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";
import {
  buildChildDetailQuery,
  formatChildDetail,
  formatStatus,
  formatTimestamp,
} from "./get-task-status-format.js";

async function listChildren() {
  const response = await bridgeFetch("/children");

  if (!response.ok) {
    const errorMessage = await extractError(response);
    return `Failed to list tasks: ${errorMessage} (HTTP ${response.status})`;
  }

  const { children } = await response.json();

  if (!children || children.length === 0) {
    return "No child tasks found.";
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

  const header = `${children.length} child task(s): ${counts.running} running, ${counts.pending} pending, ${counts.done} done, ${counts.failed} failed`;
  return [header, "", ...lines].join("\n");
}

async function getChildDetail(taskId, options = {}) {
  const encodedTaskId = encodeURIComponent(taskId);
  const response = await bridgeFetch(`/children/${encodedTaskId}${buildChildDetailQuery(options)}`);

  if (!response.ok) {
    if (response.status === 404) {
      return `Task "${taskId}" not found. Use get-task-status without a taskId to list all tasks.`;
    }
    const errorMessage = await extractError(response);
    return `Failed to get task: ${errorMessage} (HTTP ${response.status})`;
  }

  const detail = await response.json();
  return formatChildDetail(detail, taskId, options);
}

export default tool({
  name: "get-task-status",
  description:
    "Check child task status. Without a taskId, lists all child tasks with summary counts. With a taskId, returns details. Set includeResponse to retrieve the child's final assistant response when available. Set includeTrajectory for a paginated persisted event trajectory.",
  args: {
    taskId: z
      .string()
      .optional()
      .describe("Specific task ID to get details for. Omit to list all child tasks."),
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
      if (args.taskId) {
        return await getChildDetail(args.taskId, {
          includeResponse: args.includeResponse,
          includeTrajectory: args.includeTrajectory || args.includeEventData,
          trajectoryLimit: args.trajectoryLimit,
          trajectoryCursor: args.trajectoryCursor,
          includeEventData: args.includeEventData,
        });
      }
      return await listChildren();
    } catch (error) {
      return `Failed to get task status: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});
