import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { bridgeFetch, controlPlaneFetch, extractError } from "./_bridge-client.js"
import { readFileSync } from "fs"

export default tool({
  name: "send-update",
  description:
    "Send a progress update to the user. The message appears in real-time wherever the " +
    "session was started (Slack thread, web UI, or Linear issue). Use this to report " +
    "milestones, share screenshots, or ask for input during long tasks. If a screenshot " +
    "path is provided, the image is uploaded to cloud storage and included in the update.",
  args: {
    message: z.string().describe("Update message (markdown supported)"),
    screenshotPath: z
      .string()
      .optional()
      .describe(
        "Path to a screenshot file (e.g., from agent-browser screenshot --path /tmp/screenshot.png)"
      ),
  },
  async execute(args) {
    let screenshotUrl = null

    if (args.screenshotPath) {
      let buffer
      try {
        buffer = readFileSync(args.screenshotPath)
      } catch (e) {
        return `Failed to read screenshot at ${args.screenshotPath}: ${e.message}`
      }

      const uploadResp = await controlPlaneFetch("/api/media/upload", {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "X-Filename": "screenshot.png",
        },
        body: buffer,
      })

      if (!uploadResp.ok) {
        const err = await extractError(uploadResp)
        return `Screenshot upload failed (${uploadResp.status}): ${err}`
      }

      const { url } = await uploadResp.json()
      screenshotUrl = url
    }

    const response = await bridgeFetch("/agent-update", {
      method: "POST",
      body: JSON.stringify({
        message: args.message,
        screenshotUrl,
      }),
    })

    if (!response.ok) {
      const err = await extractError(response)
      return `Failed to send update (${response.status}): ${err}`
    }

    return screenshotUrl
      ? `Update sent with screenshot: ${screenshotUrl}`
      : "Update sent to the user."
  },
})
