/**
 * Preview Tool for Open-Inspect.
 *
 * Exposes a local dev server to the internet via Cloudflare Tunnel (cloudflared).
 * Reports the preview URL as an artifact so it's visible in the session UI
 * and clickable by the user.
 *
 * Uses tool() helper from @opencode-ai/plugin with tool.schema for Zod compatibility.
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { spawn } from "node:child_process"

console.log("[preview-tool] Tool module loaded")

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || "http://localhost:8787"
const SANDBOX_AUTH_TOKEN = process.env.SANDBOX_AUTH_TOKEN || ""

function getSessionId() {
  try {
    const config = JSON.parse(process.env.SESSION_CONFIG || "{}")
    return config.sessionId || config.session_id || ""
  } catch {
    return ""
  }
}

// track active tunnels so we can reuse or kill them
const _activeTunnels = new Map() // port -> { process, url }

/**
 * Start a cloudflared tunnel and wait for it to output the public URL.
 */
function startTunnel(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let resolved = false
    const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/

    const handleOutput = (data) => {
      const text = data.toString()
      console.log(`[preview-tool] cloudflared: ${text.trim()}`)

      if (!resolved) {
        const match = text.match(urlRegex)
        if (match) {
          resolved = true
          resolve({ process: proc, url: match[0] })
        }
      }
    }

    proc.stdout.on("data", handleOutput)
    proc.stderr.on("data", handleOutput)

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true
        reject(new Error(`Failed to start cloudflared: ${err.message}`))
      }
    })

    proc.on("exit", (code) => {
      if (!resolved) {
        resolved = true
        reject(new Error(`cloudflared exited with code ${code} before providing a URL`))
      }
    })

    // timeout after 30 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        proc.kill()
        reject(new Error("Timed out waiting for cloudflared tunnel URL (30s)"))
      }
    }, 30000)
  })
}

export default tool({
  name: "preview",
  description:
    "Create a publicly accessible preview URL for a local dev server. " +
    "This exposes the dev server via a Cloudflare Tunnel so users can view the app " +
    "in their browser. The preview URL is displayed in the session UI. " +
    "The dev server must be running first. The tunnel stays active for the duration of the session.",
  args: {
    port: z
      .number()
      .optional()
      .describe("Local port to expose. Defaults to 3000."),
    description: z
      .string()
      .optional()
      .describe("Brief description of what this preview shows"),
  },
  async execute(args) {
    const port = args.port || 3000

    console.log(`[preview-tool] Creating tunnel for port ${port}`)

    // check if we already have a tunnel for this port
    const existing = _activeTunnels.get(port)
    if (existing) {
      return (
        `Preview tunnel already active for port ${port}.\n\n` +
        `URL: ${existing.url}\n\n` +
        `The preview URL is visible in the session UI.`
      )
    }

    try {
      // verify the dev server is actually running first
      try {
        await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(3000) })
      } catch {
        return (
          `Cannot create preview: no server detected on port ${port}. ` +
          `Make sure the dev server is running first (e.g., \`npm run dev\`).`
        )
      }

      const tunnel = await startTunnel(port)
      _activeTunnels.set(port, tunnel)

      console.log(`[preview-tool] Tunnel active: ${tunnel.url}`)

      // warm up the tunnel — cloudflared prints the url before it's fully registered
      // at the edge, so the first request often gets a 530. retry a few times.
      for (let i = 0; i < 5; i++) {
        try {
          const res = await fetch(tunnel.url, { signal: AbortSignal.timeout(5000) })
          if (res.ok || res.status < 500) break
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 2000))
      }

      // clean up tunnel when process exits
      tunnel.process.on("exit", () => {
        _activeTunnels.delete(port)
        console.log(`[preview-tool] Tunnel for port ${port} closed`)
      })

      // report the preview url to control plane as an artifact
      const sessionId = getSessionId()
      if (sessionId) {
        try {
          const artifactUrl = `${CONTROL_PLANE_URL}/sessions/${sessionId}/artifact`
          const response = await fetch(artifactUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${SANDBOX_AUTH_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "preview",
              url: tunnel.url,
              metadata: {
                port,
                description: args.description || null,
                createdAt: Date.now(),
              },
            }),
          })

          if (!response.ok) {
            console.log(`[preview-tool] Failed to report artifact: ${response.status}`)
          } else {
            console.log(`[preview-tool] Artifact reported to control plane`)
          }
        } catch (err) {
          console.log(`[preview-tool] Failed to report artifact: ${err.message}`)
        }
      }

      return (
        `Preview URL created!\n\n` +
        `URL: ${tunnel.url}\n` +
        `Local: http://localhost:${port}\n\n` +
        `The preview URL is now visible in the session UI. ` +
        `Users can click it to view the running app.\n` +
        `The tunnel will stay active for the duration of this session.`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[preview-tool] Error: ${message}`)

      if (message.includes("ENOENT") || message.includes("not found")) {
        return (
          "Failed to create preview: cloudflared is not installed in the sandbox. " +
          "Please contact the platform team to add it to the base image."
        )
      }

      return `Failed to create preview: ${message}`
    }
  },
})
