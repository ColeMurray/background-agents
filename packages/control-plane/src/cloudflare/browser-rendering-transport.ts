import {
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

/**
 * The browser transport over the Workers Browser Rendering binding.
 *
 * Each request is a fresh browser run with no cookie jar, so a page never
 * inherits a human's session and one session never sees another's browser
 * state. The deployment decides which hosts the session may name, and this
 * transport only carries out what the session already authorized.
 *
 * Browser Rendering currently exposes no request interception capable of
 * enforcing the reviewed host across redirects and subresources. The
 * transport therefore advertises itself as unavailable and fails closed even
 * when the deployment flag is enabled. It may become available only when the
 * platform supplies enforceable per-request host guardrails.
 */
export class BrowserRenderingTransport implements PiBrowserTransport {
  constructor(_binding: BrowserRenderingBinding | undefined) {}

  available(): boolean {
    return false;
  }

  async run(_request: PiBrowserRequest, _signal?: AbortSignal): Promise<PiBrowserOutcome> {
    throw new Error("Browser Rendering cannot enforce redirect and subresource host policy");
  }
}
