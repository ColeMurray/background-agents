/**
 * Browser Interaction Tool for Open-Inspect.
 *
 * Provides the agent with browser automation capabilities via Playwright.
 * The agent can navigate pages, click elements, fill forms, and extract content
 * to visually verify and interact with the running dev server.
 *
 * Uses tool() helper from @opencode-ai/plugin with tool.schema for Zod compatibility.
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

console.log("[browser-tool] Tool module loaded")

// persistent browser + page across calls for stateful interaction
let _browserPromise = null
let _currentPage = null
let _currentContext = null

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

async function getPage(width = 1280, height = 720) {
  const browser = await getBrowser()

  // reuse existing page if browser context is still open
  if (_currentPage && !_currentPage.isClosed()) {
    return _currentPage
  }

  // close old context if it exists
  if (_currentContext) {
    try { await _currentContext.close() } catch { /* noop */ }
  }

  _currentContext = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  })
  _currentPage = await _currentContext.newPage()
  return _currentPage
}

export default tool({
  name: "browser",
  description:
    "Interact with a web page in a headless browser. Playwright and Chromium are already pre-installed — do NOT install them. " +
    "Use this to navigate, click, type, scroll, " +
    "and extract information from your running dev server. The browser session is persistent " +
    "across calls, so you can navigate to a page and then interact with it in subsequent calls. " +
    "Always start with action 'navigate' to open a page. Use 'screenshot' tool separately if " +
    "you need to capture visual output.",
  args: {
    action: z
      .enum([
        "navigate",
        "click",
        "type",
        "fill",
        "select",
        "hover",
        "scroll",
        "wait",
        "evaluate",
        "get_text",
        "get_html",
        "get_attribute",
        "query_all",
        "close",
      ])
      .describe(
        "Action to perform. " +
        "'navigate': go to a URL. " +
        "'click': click an element. " +
        "'type': type text character by character (appends). " +
        "'fill': clear and fill an input. " +
        "'select': select an option in a <select>. " +
        "'hover': hover over an element. " +
        "'scroll': scroll the page or an element. " +
        "'wait': wait for a selector or timeout. " +
        "'evaluate': run JavaScript in the page context. " +
        "'get_text': get text content of an element. " +
        "'get_html': get innerHTML of an element. " +
        "'get_attribute': get an attribute value. " +
        "'query_all': get text content of all matching elements. " +
        "'close': close the browser session."
      ),
    url: z.string().optional().describe("URL to navigate to (for 'navigate' action)"),
    selector: z.string().optional().describe("CSS selector for the target element"),
    text: z.string().optional().describe("Text to type or fill"),
    value: z.string().optional().describe("Value for 'select' action or attribute name for 'get_attribute'"),
    script: z.string().optional().describe("JavaScript to evaluate in the page context (for 'evaluate' action)"),
    scrollY: z.number().optional().describe("Pixels to scroll vertically (positive = down). For 'scroll' action."),
    scrollX: z.number().optional().describe("Pixels to scroll horizontally. For 'scroll' action."),
    timeout: z.number().optional().describe("Timeout in ms for wait operations. Defaults to 10000."),
  },
  async execute(args) {
    const { action, timeout = 10000 } = args

    try {
      if (action === "close") {
        if (_currentContext) {
          await _currentContext.close()
          _currentContext = null
          _currentPage = null
        }
        return "Browser session closed."
      }

      const page = await getPage()

      switch (action) {
        case "navigate": {
          const url = args.url || "http://localhost:3000"
          console.log(`[browser-tool] Navigating to ${url}`)
          await page.goto(url, { waitUntil: "networkidle", timeout: 30000 })
          const title = await page.title()
          const currentUrl = page.url()
          return `Navigated to: ${currentUrl}\nTitle: ${title}`
        }

        case "click": {
          if (!args.selector) return "Error: 'selector' is required for click action"
          console.log(`[browser-tool] Clicking: ${args.selector}`)
          await page.click(args.selector, { timeout })
          return `Clicked: ${args.selector}`
        }

        case "type": {
          if (!args.selector) return "Error: 'selector' is required for type action"
          if (!args.text) return "Error: 'text' is required for type action"
          await page.type(args.selector, args.text, { timeout })
          return `Typed "${args.text}" into ${args.selector}`
        }

        case "fill": {
          if (!args.selector) return "Error: 'selector' is required for fill action"
          if (args.text === undefined) return "Error: 'text' is required for fill action"
          await page.fill(args.selector, args.text, { timeout })
          return `Filled ${args.selector} with "${args.text}"`
        }

        case "select": {
          if (!args.selector) return "Error: 'selector' is required for select action"
          if (!args.value) return "Error: 'value' is required for select action"
          await page.selectOption(args.selector, args.value, { timeout })
          return `Selected "${args.value}" in ${args.selector}`
        }

        case "hover": {
          if (!args.selector) return "Error: 'selector' is required for hover action"
          await page.hover(args.selector, { timeout })
          return `Hovered over: ${args.selector}`
        }

        case "scroll": {
          const x = args.scrollX || 0
          const y = args.scrollY || 0
          if (args.selector) {
            await page.$eval(
              args.selector,
              (el, { x, y }) => el.scrollBy(x, y),
              { x, y }
            )
            return `Scrolled ${args.selector} by (${x}, ${y})`
          } else {
            await page.evaluate(({ x, y }) => window.scrollBy(x, y), { x, y })
            return `Scrolled page by (${x}, ${y})`
          }
        }

        case "wait": {
          if (args.selector) {
            await page.waitForSelector(args.selector, { timeout })
            return `Element found: ${args.selector}`
          } else {
            const waitMs = timeout || 1000
            await new Promise((resolve) => setTimeout(resolve, waitMs))
            return `Waited ${waitMs}ms`
          }
        }

        case "evaluate": {
          if (!args.script) return "Error: 'script' is required for evaluate action"
          console.log(`[browser-tool] Evaluating script`)
          const result = await page.evaluate(args.script)
          const output = typeof result === "object" ? JSON.stringify(result, null, 2) : String(result)
          // cap output to avoid blowing token limits
          if (output.length > 5000) {
            return output.slice(0, 5000) + "\n... (output truncated at 5000 chars)"
          }
          return output
        }

        case "get_text": {
          if (!args.selector) return "Error: 'selector' is required for get_text action"
          const text = await page.textContent(args.selector, { timeout })
          if (text === null) return `No element found for: ${args.selector}`
          const trimmed = text.trim()
          if (trimmed.length > 5000) {
            return trimmed.slice(0, 5000) + "\n... (text truncated at 5000 chars)"
          }
          return trimmed
        }

        case "get_html": {
          if (!args.selector) return "Error: 'selector' is required for get_html action"
          const html = await page.innerHTML(args.selector, { timeout })
          if (html.length > 5000) {
            return html.slice(0, 5000) + "\n... (HTML truncated at 5000 chars)"
          }
          return html
        }

        case "get_attribute": {
          if (!args.selector) return "Error: 'selector' is required for get_attribute action"
          if (!args.value) return "Error: 'value' (attribute name) is required for get_attribute action"
          const attr = await page.getAttribute(args.selector, args.value, { timeout })
          return attr !== null ? attr : `Attribute "${args.value}" not found on ${args.selector}`
        }

        case "query_all": {
          if (!args.selector) return "Error: 'selector' is required for query_all action"
          const elements = await page.$$(args.selector)
          const texts = []
          for (const el of elements.slice(0, 50)) {
            const t = await el.textContent()
            if (t) texts.push(t.trim())
          }
          if (texts.length === 0) return `No elements found for: ${args.selector}`
          const output = texts.map((t, i) => `[${i}] ${t}`).join("\n")
          if (output.length > 5000) {
            return output.slice(0, 5000) + `\n... (${elements.length} total elements, output truncated)`
          }
          return `Found ${elements.length} elements:\n${output}`
        }

        default:
          return `Unknown action: ${action}`
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[browser-tool] Error: ${message}`)

      if (message.includes("net::ERR_CONNECTION_REFUSED")) {
        return (
          `Browser error: Could not connect to the page. ` +
          `Make sure the dev server is running first.`
        )
      }

      return `Browser error: ${message}`
    }
  },
})
