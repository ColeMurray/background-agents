import {
  MAX_PI_BROWSER_SCREENSHOT_BYTES,
  MAX_PI_BROWSER_TEXT_BYTES,
  PI_BROWSER_TIMEOUT_MS,
  type PiBrowserOutcome,
  type PiBrowserRequest,
  type PiBrowserTransport,
} from "../pi/browser-transport";

/**
 * The Workers Browser Rendering binding.
 *
 * The binding serves two forms: the Quick Action form, a method on the binding
 * that the Agents SDK's own helpers use, and the classic form, a fetch to the
 * rendering endpoint.
 *
 * The transport uses the classic form, because the SDK's Quick Action helpers
 * live behind `agents/browser`, whose entry point imports the optional
 * `@cloudflare/codemode` peer — a package this checkout does not install, so
 * importing it fails at build time. The classic form is the documented
 * Browser Rendering endpoint and needs no extra dependency.
 *
 * If a deployment installs `@cloudflare/codemode`, the SDK's helpers
 * (`browserMarkdown`, `browserScreenshot`) become the better path: they
 * build the request, read the answer's envelope, and raise a typed error.
 */
export interface BrowserRenderingBinding {
  /** The Quick Action form, when the binding has it. */
  quickAction?(action: string, options: unknown): Promise<Response>;
  /** The classic form. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The Browser Rendering service endpoint the binding serves. */
const BROWSER_RENDERING_ENDPOINT = "https://browser-rendering-endpoint";

/**
 * The browser transport over the Workers Browser Rendering binding.
 *
 * Each request is a fresh browser run with no cookie jar, so a page never
 * inherits a human's session and one session never sees another's browser
 * state. The deployment decides which hosts the session may name, and this
 * transport only carries out what the session already authorized.
 *
 * The named host is the only host the session's list covers: a Quick Action
 * has no hostname guardrails, so what the page itself loads is not bounded
 * by that list. See `PI-BROWSER-CONTEXT-AUDIT.md` §5.2.
 */
export class BrowserRenderingTransport implements PiBrowserTransport {
  constructor(private readonly binding: BrowserRenderingBinding | undefined) {}

  available(): boolean {
    return this.binding !== undefined;
  }

  async run(request: PiBrowserRequest, signal?: AbortSignal): Promise<PiBrowserOutcome> {
    const binding = this.binding;
    if (!binding) throw new Error("The browser is not available in this deployment");
    const timeout = AbortSignal.timeout(PI_BROWSER_TIMEOUT_MS);
    const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const target = `${BROWSER_RENDERING_ENDPOINT}/${request.action === "screenshot" ? "screenshot" : "markdown"}?url=${encodeURIComponent(request.url)}`;
    const response = await binding.fetch(target, {
      headers: { Accept: request.action === "screenshot" ? "image/png" : "text/markdown" },
      signal: composite,
    });
    if (!response.ok) {
      // The provider's own string stays inside the platform. The model only
      // learns that the page did not load.
      throw new Error("The page could not be loaded");
    }
    if (request.action === "screenshot") {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const truncated = bytes.byteLength > MAX_PI_BROWSER_SCREENSHOT_BYTES;
      const bounded = truncated ? bytes.slice(0, MAX_PI_BROWSER_SCREENSHOT_BYTES) : bytes;
      return {
        action: request.action,
        url: request.url,
        truncated,
        screenshot: { data: toBase64(bounded), mimeType: "image/png" },
      };
    }
    const text = await response.text();
    const truncated = text.length > MAX_PI_BROWSER_TEXT_BYTES;
    return {
      action: request.action,
      url: request.url,
      truncated,
      text: truncated ? text.slice(0, MAX_PI_BROWSER_TEXT_BYTES) : text,
    };
  }
}

/** The base64 form of a screenshot, without depending on a runtime helper. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
