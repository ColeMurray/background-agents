/**
 * Create Pull Request Tool for Open-Inspect.
 *
 * This tool creates a pull request for committed changes.
 * Uses tool() helper from @opencode-ai/plugin with tool.schema for Zod compatibility.
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

// Debug: Log that the tool was loaded
console.log("[create-pull-request] Tool module loaded")
console.log("[create-pull-request] CONTROL_PLANE_URL:", process.env.CONTROL_PLANE_URL || "<not set>")
console.log("[create-pull-request] SANDBOX_AUTH_TOKEN:", process.env.SANDBOX_AUTH_TOKEN ? "<set>" : "<not set>")
console.log("[create-pull-request] SESSION_CONFIG:", process.env.SESSION_CONFIG ? "<set>" : "<not set>")

// Get bridge configuration from environment
const BRIDGE_URL = process.env.CONTROL_PLANE_URL || "http://localhost:8787"
const BRIDGE_TOKEN = process.env.SANDBOX_AUTH_TOKEN || ""

// Get session ID from SESSION_CONFIG
function getSessionId() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}")
    console.log("[create-pull-request] Parsed SESSION_CONFIG, sessionId:", config.sessionId || config.session_id || "<not found>")
    return config.sessionId || config.session_id || ""
  } catch (e) {
    console.log("[create-pull-request] Failed to parse SESSION_CONFIG:", e.message)
    return ""
  }
}

// Use tool() helper - args should be a ZodRawShape (plain object), NOT a ZodObject
// OpenCode wraps it with z.object() internally
export default tool({
  name: "create-pull-request",
  description: "Create a pull request for the committed changes. DO NOT use 'gh' CLI - use this tool instead. It handles git push and PR creation automatically with pre-configured authentication. You MUST provide a descriptive title and body that explain what changes were made. Call this after committing your changes.",
  args: {
    title: z.string().describe("Title of the pull request. Should be concise and descriptive of the changes made."),
    body: z.string().describe("Body/description of the pull request. Explain what changes were made and why. Use markdown formatting for clarity."),
    baseBranch: z.string().optional().describe("Target branch to merge into. Defaults to the repository's default branch (usually 'main')."),
  },
  async execute(args, context) {
    console.log(`[create-pull-request] execute() called with args:`, JSON.stringify(args))
    const title = args.title || "Changes from OpenCode session"
    const body = args.body || "Automated PR created via create-pull-request tool"
    const baseBranch = args.baseBranch // undefined if not provided, server will use default

    try {
      const sessionId = getSessionId()
      console.log(`[create-pull-request] Session ID: ${sessionId || "<empty>"}`)
      console.log(`[create-pull-request] Bridge URL: ${BRIDGE_URL}`)
      console.log(`[create-pull-request] Bridge Token: ${BRIDGE_TOKEN ? "<set>" : "<not set>"}`)

      if (!sessionId) {
        console.log("[create-pull-request] ERROR: Session ID not found")
        return "Failed to create pull request: Session ID not found in environment. Please check that SESSION_CONFIG is set correctly."
      }

      // Use the session-specific endpoint
      const url = `${BRIDGE_URL}/sessions/${sessionId}/pr`
      console.log(`[create-pull-request] Calling PR endpoint: ${url}`)

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${BRIDGE_TOKEN}`,
        },
        body: JSON.stringify({
          title: title,
          body: body,
          baseBranch: baseBranch,
          timestamp: Date.now(),
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        // Try to parse as JSON to get structured error message
        let errorMessage = errorText
        try {
          const errorJson = JSON.parse(errorText)
          errorMessage = errorJson.error || errorJson.message || errorText
        } catch {
          // Use raw text if not JSON
        }

        // Provide helpful messages based on status code
        let userMessage = `Failed to create pull request: ${errorMessage}`
        if (response.status === 401) {
          userMessage = `Authentication failed: ${errorMessage}. The GitHub token may have expired - please re-authenticate.`
        } else if (response.status === 404) {
          userMessage = `Session not found: ${errorMessage}. The session may have been deleted or the ID is incorrect.`
        } else if (response.status === 409) {
          userMessage = `Conflict: ${errorMessage}. A PR may already exist for this branch.`
        }

        console.log(`[create-pull-request] ERROR: HTTP ${response.status} - ${errorMessage}`)
        return userMessage
      }

      const result = await response.json()
      console.log(`[create-pull-request] SUCCESS: PR #${result.prNumber} created`)
      return `Pull request created successfully!\n\nPR #${result.prNumber}: ${result.prUrl}\n\nThe PR is now ready for review.`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[create-pull-request] ERROR: ${message}`)
      return `Failed to create pull request: ${message}`
    }
  },
})
