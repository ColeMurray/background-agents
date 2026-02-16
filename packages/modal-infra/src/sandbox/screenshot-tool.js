/**
 * Screenshot Tool for Open-Inspect.
 *
 * Takes screenshots of the running dev server using Playwright.
 * Uploads the screenshot to the control plane which stores it in R2.
 * Creates a screenshot artifact visible in the session UI.
 *
 * Uses tool() helper from @opencode-ai/plugin with tool.schema for Zod compatibility.
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

console.log("[screenshot-tool] Tool module loaded")

// get bridge configuration from environment
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

// reusable browser instance to avoid cold start on every screenshot
let _browserPromise = null

async function getBrowser() {
  if (_browserPromise) return _browserPromise

  _browserPromise = (async () => {
    const { chromium } = await import("playwright")
    return chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    })
  })()

  return _browserPromise
}

export default tool({
  name: "screenshot",
  description:
    "Take a screenshot of a running web page. Use this to visually verify your changes. " +
    "Playwright and Chromium are already pre-installed — do NOT install them. " +
    "The dev server must be running first (e.g., via `npm run dev`). " +
    "Returns a URL to the screenshot image that is visible in the session UI. " +
    "You can screenshot specific elements with a CSS selector, or capture the full page.",
  args: {
    url: z
      .string()
      .optional()
      .describe(
        "URL to screenshot. Defaults to http://localhost:3000. " +
        "Use the port your dev server is running on."
      ),
    selector: z
      .string()
      .optional()
      .describe("CSS selector to screenshot a specific element instead of the full viewport"),
    fullPage: z
      .boolean()
      .optional()
      .describe("Capture the full scrollable page instead of just the viewport. Defaults to false."),
    width: z.number().optional().describe("Viewport width in pixels. Defaults to 1280."),
    height: z.number().optional().describe("Viewport height in pixels. Defaults to 720."),
    waitForSelector: z
      .string()
      .optional()
      .describe("Wait for this CSS selector to appear before taking the screenshot"),
    waitMs: z
      .number()
      .optional()
      .describe("Additional milliseconds to wait after page load before screenshotting"),
    description: z
      .string()
      .optional()
      .describe("Brief description of what this screenshot shows (used in the artifact metadata)"),
  },
  async execute(args) {
    const targetUrl = args.url || "http://localhost:3000"
    const viewportWidth = args.width || 1280
    const viewportHeight = args.height || 720

    console.log(`[screenshot-tool] Capturing ${targetUrl}`)

    let browser
    let page
    try {
      browser = await getBrowser()
      const context = await browser.newContext({
        viewport: { width: viewportWidth, height: viewportHeight },
        deviceScaleFactor: 2, // retina for crisp screenshots
      })
      page = await context.newPage()

      // navigate to the target url
      await page.goto(targetUrl, {
        waitUntil: "networkidle",
        timeout: 30000,
      })

      // wait for a specific selector if requested
      if (args.waitForSelector) {
        await page.waitForSelector(args.waitForSelector, { timeout: 10000 })
      }

      // additional wait if requested
      if (args.waitMs && args.waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, args.waitMs))
      }

      // take the screenshot
      let screenshotBuffer
      if (args.selector) {
        const element = await page.$(args.selector)
        if (!element) {
          await context.close()
          return `Failed to take screenshot: element matching "${args.selector}" not found on the page.`
        }
        screenshotBuffer = await element.screenshot({ type: "png" })
      } else {
        screenshotBuffer = await page.screenshot({
          fullPage: args.fullPage ?? false,
          type: "png",
        })
      }

      await context.close()

      // upload to control plane
      const sessionId = getSessionId()
      if (!sessionId) {
        return "Screenshot captured but could not upload: session ID not found in environment."
      }

      const uploadUrl = `${CONTROL_PLANE_URL}/sessions/${sessionId}/artifact`
      console.log(`[screenshot-tool] Uploading to ${uploadUrl}`)

      // send as multipart form data
      const formData = new FormData()
      formData.append("type", "screenshot")
      formData.append(
        "file",
        new Blob([screenshotBuffer], { type: "image/png" }),
        "screenshot.png"
      )
      formData.append(
        "metadata",
        JSON.stringify({
          url: targetUrl,
          selector: args.selector || null,
          fullPage: args.fullPage ?? false,
          viewport: { width: viewportWidth, height: viewportHeight },
          description: args.description || null,
          capturedAt: Date.now(),
        })
      )

      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SANDBOX_AUTH_TOKEN}`,
        },
        body: formData,
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.log(`[screenshot-tool] Upload failed: ${response.status} - ${errorText}`)
        return `Screenshot captured but upload failed (${response.status}): ${errorText}`
      }

      const result = await response.json()
      console.log(`[screenshot-tool] Screenshot uploaded: ${result.url}`)

      return (
        `Screenshot captured successfully!\n\n` +
        `URL: ${result.url}\n` +
        `Page: ${targetUrl}\n` +
        (args.selector ? `Element: ${args.selector}\n` : "") +
        (args.description ? `Description: ${args.description}\n` : "") +
        `\nThe screenshot is now visible in the session UI.`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[screenshot-tool] Error: ${message}`)

      if (message.includes("net::ERR_CONNECTION_REFUSED")) {
        return (
          `Failed to take screenshot: Could not connect to ${targetUrl}. ` +
          `Make sure the dev server is running first (e.g., \`npm run dev\`).`
        )
      }

      return `Failed to take screenshot: ${message}`
    }
  },
})
