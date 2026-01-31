/**
 * Take Screenshot Tool for Open-Inspect.
 *
 * Captures a screenshot of a URL (e.g. local dev server) using Playwright and uploads
 * it to the control plane as a session artifact. Uses a Python helper script that
 * runs in the sandbox (Playwright is installed via pip in the image).
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { execFileSync } from "node:child_process"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const BRIDGE_URL = process.env.CONTROL_PLANE_URL || "http://localhost:8787"
const BRIDGE_TOKEN = process.env.SANDBOX_AUTH_TOKEN || ""

function getSessionId() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}")
    return config.sessionId || config.session_id || ""
  } catch {
    return ""
  }
}

export default tool({
  name: "take-screenshot",
  description:
    "Capture a screenshot of the application being developed (the repo's frontend/app). NEVER screenshot VS Code or the IDE — that is on port 8080 and is irrelevant. " +
    "Always capture the user's app: use http://localhost:5173 (Vite/Svelte), http://localhost:3000 (Next.js/CRA), or whatever port the dev server uses. " +
    "Start the dev server first (e.g. pnpm dev) if not already running. For external pages, use https:// URLs.",
  args: {
    url: z.string().describe("URL of the application to capture. Use 5173 (Vite), 3000 (Next.js), or the app's dev server port. NEVER use 8080 (that is VS Code)."),
    fullPage: z.boolean().optional().describe("Capture the full scrollable page. Default: false"),
    viewportWidth: z.number().optional().describe("Viewport width in pixels. Default: 1280"),
    viewportHeight: z.number().optional().describe("Viewport height in pixels. Default: 720"),
  },
  async execute(args) {
    const sessionId = getSessionId()
    console.log("[take-screenshot] sessionId:", sessionId || "<empty>", "bridgeToken:", BRIDGE_TOKEN ? "<set>" : "<not set>")
    if (!sessionId) {
      return {
        content: "Failed to take screenshot: Session ID not found in environment (SESSION_CONFIG).",
        success: false,
      }
    }
    if (!BRIDGE_TOKEN) {
      return {
        content: "Failed to take screenshot: Sandbox auth token not set.",
        success: false,
      }
    }

    const url = args.url || "http://localhost:5173"
    if (url.includes("localhost:8080") || url.includes("127.0.0.1:8080")) {
      return {
        content: "Port 8080 is VS Code/the IDE — never screenshot that. Screenshot the application instead: start the dev server (pnpm dev) and use http://localhost:5173 (Vite) or http://localhost:3000 (Next.js).",
        success: false,
      }
    }
    console.log("[take-screenshot] Capturing URL:", url)
    const dir = mkdtempSync(join(tmpdir(), "screenshot-"))
    const outputPath = join(dir, "screenshot.png")

    try {
      const scriptPath = "/app/sandbox/take_screenshot.py"
      const execArgs = [
        scriptPath,
        url,
        outputPath,
        ...(args.fullPage ? ["--full-page"] : []),
        ...(args.viewportWidth != null ? ["--viewport-width", String(args.viewportWidth)] : []),
        ...(args.viewportHeight != null ? ["--viewport-height", String(args.viewportHeight)] : []),
      ]
      execFileSync("python3", execArgs, { stdio: "pipe", timeout: 35000 })

      const buffer = readFileSync(outputPath)
      const form = new FormData()
      form.append("file", new Blob([buffer], { type: "image/png" }), "screenshot.png")
      form.append("type", "screenshot")
      const metadata = { url, fullPage: args.fullPage ?? false }
      form.append("metadata", JSON.stringify(metadata))

      const response = await fetch(`${BRIDGE_URL}/sessions/${sessionId}/artifacts`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${BRIDGE_TOKEN}` },
        body: form,
      })

      if (!response.ok) {
        const errText = await response.text()
        let errMsg = errText
        try {
          const j = JSON.parse(errText)
          errMsg = j.error || errText
        } catch {}
        console.error("[take-screenshot] Upload failed:", response.status, errMsg)
        return {
          content: `Failed to upload screenshot: ${errMsg}`,
          success: false,
        }
      }

      const result = await response.json()
      return {
        content: `Screenshot saved. View it in the session: ${result.url}`,
        success: true,
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error("[take-screenshot] Error:", message, e)
      const isConnectionRefused = message.includes("ERR_CONNECTION_REFUSED")
      const hint = isConnectionRefused
        ? ` Nothing is listening — start the app's dev server first (e.g. pnpm dev for port 5173). Do NOT use port 8080 (VS Code). Or use a public URL like https://example.com.`
        : " Ensure the URL is reachable from the sandbox."
      return {
        content: `Failed to take screenshot: ${message}.${hint}`,
        success: false,
      }
    } finally {
      try {
        rmSync(dir, { recursive: true })
      } catch {}
    }
  },
})
