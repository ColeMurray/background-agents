/**
 * Get Task Status Tool — check on child task progress.
 *
 * Dual-mode: omit taskId to list all children, or provide one for details.
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { bridgeFetch, extractError } from "./_bridge-client.js"

const STATUS_LABELS = {
  created: "PENDING",
  active: "RUNNING",
  completed: "DONE",
  cancelled: "CANCELLED",
  archived: "DONE",
}

function formatStatus(status) {
  return STATUS_LABELS[status] || status.toUpperCase()
}

function formatTimestamp(ts) {
  if (!ts) return "n/a"
  return new Date(ts).toISOString()
}

async function listChildren() {
  const response = await bridgeFetch("/children")

  if (!response.ok) {
    const errorMessage = await extractError(response)
    return `Failed to list tasks: ${errorMessage} (HTTP ${response.status})`
  }

  const { children } = await response.json()

  if (!children || children.length === 0) {
    return "No child tasks found."
  }

  const counts = { pending: 0, running: 0, done: 0 }
  const lines = []

  for (const child of children) {
    const label = formatStatus(child.status)
    if (label === "PENDING") counts.pending++
    else if (label === "RUNNING") counts.running++
    else counts.done++

    lines.push(
      `  [${label}] ${child.id}`,
      `    Title: ${child.title || "(untitled)"}`,
      `    Created: ${formatTimestamp(child.createdAt)}`,
      ""
    )
  }

  const header = `${children.length} child task(s): ${counts.running} running, ${counts.pending} pending, ${counts.done} done`
  return [header, "", ...lines].join("\n")
}

async function getChildDetail(taskId) {
  const response = await bridgeFetch(`/children/${taskId}`)

  if (!response.ok) {
    if (response.status === 404) {
      return `Task "${taskId}" not found. Use get-task-status without a taskId to list all tasks.`
    }
    const errorMessage = await extractError(response)
    return `Failed to get task: ${errorMessage} (HTTP ${response.status})`
  }

  const detail = await response.json()
  const s = detail.session || {}
  const lines = [
    `Task: ${s.id || taskId}`,
    `  Title:   ${s.title || "(untitled)"}`,
    `  Status:  ${formatStatus(s.status || "unknown")}`,
    `  Model:   ${s.model || "default"}`,
    `  Repo:    ${s.repoOwner || ""}/${s.repoName || ""}`,
    `  Branch:  ${s.branchName || "(none)"}`,
    `  Created: ${formatTimestamp(s.createdAt)}`,
    `  Updated: ${formatTimestamp(s.updatedAt)}`,
  ]

  if (detail.sandbox) {
    lines.push(`  Sandbox: ${detail.sandbox.status}`)
  }

  if (detail.artifacts && detail.artifacts.length > 0) {
    lines.push("", "  Artifacts:")
    for (const a of detail.artifacts) {
      const label = a.type === "pr" ? `PR: ${a.url}` : `${a.type}: ${a.url}`
      lines.push(`    - ${label}`)
    }
  }

  if (detail.recentEvents && detail.recentEvents.length > 0) {
    lines.push("", "  Recent events:")
    for (const e of detail.recentEvents) {
      const time = formatTimestamp(e.createdAt)
      const raw = e.data?.message || e.data?.content || e.type
      const summary = typeof raw === "string" ? raw : JSON.stringify(raw)
      lines.push(`    [${time}] ${e.type}: ${summary.slice(0, 120)}`)
    }
  }

  return lines.join("\n")
}

export default tool({
  name: "get-task-status",
  description:
    "Check the status of child tasks. Without a taskId, lists all child tasks with summary counts. With a taskId, returns detailed information including sandbox status, artifacts (PRs), and recent events.",
  args: {
    taskId: z
      .string()
      .optional()
      .describe("Specific task ID to get details for. Omit to list all child tasks."),
  },
  async execute(args) {
    try {
      if (args.taskId) {
        return await getChildDetail(args.taskId)
      }
      return await listChildren()
    } catch (error) {
      return `Failed to get task status: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})
