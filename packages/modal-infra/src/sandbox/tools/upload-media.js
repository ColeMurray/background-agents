import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { controlPlaneFetch, extractError } from "./_bridge-client.js"
import { readFileSync } from "fs"
import { basename, extname } from "path"

const MIME_MAP = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".html": "text/html",
}

export default tool({
  name: "upload-media",
  description:
    "Upload a file to cloud storage and get back a public URL. Use this to share images, " +
    "screenshots, logs, or any file with the user. The URL can be included in messages, " +
    "comments, or PR descriptions. Commonly used after agent-browser screenshots.",
  args: {
    filePath: z.string().describe("Absolute path to the file to upload"),
    mimeType: z
      .string()
      .optional()
      .describe("MIME type (auto-detected from extension if omitted)"),
  },
  async execute(args) {
    const ext = extname(args.filePath).toLowerCase()
    const mime = args.mimeType ?? (MIME_MAP[ext] || "application/octet-stream")

    let buffer
    try {
      buffer = readFileSync(args.filePath)
    } catch (e) {
      return `Failed to read file at ${args.filePath}: ${e.message}`
    }

    const response = await controlPlaneFetch("/api/media/upload", {
      method: "POST",
      headers: {
        "Content-Type": mime,
        "X-Filename": basename(args.filePath),
      },
      body: buffer,
    })

    if (!response.ok) {
      const err = await extractError(response)
      return `Upload failed (${response.status}): ${err}`
    }

    const { url } = await response.json()
    return `Uploaded: ${url}`
  },
})
