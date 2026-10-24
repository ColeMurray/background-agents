import { z } from "zod";
import type { FeatureCapabilityMode } from "@open-inspect/shared/capability-modes";
import {
  isPiBrowserAction,
  PI_BROWSER_ACTIONS,
  PI_BROWSER_SENSITIVE_ACTIONS,
  type PiBrowserOutcome,
  type PiBrowserRequest,
} from "../../../pi/browser-transport";

/**
 * The browser gateway inside the owning session.
 *
 * The agent proposes browser work. The session authorizes it: the capability
 * must allow it, the deployment mode must allow it, and the page it names
 * must be one an operator reviewed. Only then may anything drive a browser,
 * and only for the session that asked.
 *
 * The session also holds the browser. The agent proposes; the owning session
 * decides and carries the work out, so the request that was authorized is
 * the request that runs, and the result comes back through the session that
 * audits it.
 */
export interface BrowserGatewayBridge {
  /** The live deployment mode for browser work. */
  liveMode(): FeatureCapabilityMode;
  /** The latched capability of this session. */
  sessionCapability(): FeatureCapabilityMode;
  /** The hosts this deployment allows the browser to reach. */
  allowedDomains(): readonly string[];
  /** The human actor whose turn the current operation belongs to. */
  operationActor(operationId: string): string | null;
  /** The operation must belong to this session. */
  operationBelongsToSession(operationId: string): boolean;
  /** Re-read the turn author's current workspace and session authority. */
  authorMayAct(operationId: string): Promise<boolean>;
  /** Whether this deployment stages a browser at all. */
  browserAvailable(): boolean;
  /**
   * Run one browser request.
   *
   * The session owns the browser binding, so this is where a page is
   * actually loaded. The provider's own failure never crosses this seam.
   */
  read(request: PiBrowserRequest): Promise<PiBrowserOutcome>;
  /** Record the browser activity so collaborators can see it. */
  recordActivity(input: {
    operationId: string;
    actorId: string;
    url: string | null;
    outcome: "authorized" | "refused";
    reason: string | null;
  }): void;
}

/** The decision for one browser request. */
export type BrowserAuthorization =
  { kind: "allowed"; actorId: string } | { kind: "denied"; code: string; reason: string };

/** The request the agent makes. */
export const browserRequestSchema = z
  .object({
    /**
     * The browser work the agent wants.
     *
     * It is optional because the early gate asks whether the session may
     * drive a browser at all, before any work is named. The sensitive
     * actions are named so the gateway can refuse them by name instead of
     * failing a parse.
     */
    action: z.enum([...PI_BROWSER_ACTIONS, ...PI_BROWSER_SENSITIVE_ACTIONS]).optional(),
    /**
     * The URL the agent wants to reach.
     *
     * It is optional because the early gate asks whether the session may
     * drive a browser at all, before any URL is known.
     */
    url: z.string().min(1).max(4_096).optional(),
  })
  .strict();

/**
 * One browser request, with the work named.
 *
 * The action is required here, because a request that reaches a browser has
 * to say what it wants. The sensitive actions are admitted by the schema so
 * the gateway can refuse them by name instead of failing a parse.
 */
export const browserReadRequestSchema = z
  .object({
    action: z.enum([...PI_BROWSER_ACTIONS, ...PI_BROWSER_SENSITIVE_ACTIONS]),
    url: z.string().min(1).max(4_096),
  })
  .strict();

export interface BrowserGatewayOptions {
  browser: BrowserGatewayBridge;
  getSessionId: () => string;
}

export class BrowserGateway {
  constructor(private readonly options: BrowserGatewayOptions) {}

  /**
   * Authorize one browser request.
   *
   * The order is the boundary: the session's own capability, the live
   * deployment mode, the turn's actor, and then the reviewed hosts.
   */
  async authorize(
    request: { action?: string; url?: string },
    operationId: string | null
  ): Promise<BrowserAuthorization> {
    const bridge = this.options.browser;
    // Every browser action this session may take reads a page, so a
    // read-only capability may use it.
    if (bridge.sessionCapability() === "off" || bridge.liveMode() === "off") {
      return {
        kind: "denied",
        code: "browser_disabled",
        reason: "Browser work is disabled for this session",
      };
    }
    if (!bridge.browserAvailable()) {
      return {
        kind: "denied",
        code: "browser_unavailable",
        reason: "The browser is not available in this deployment",
      };
    }
    if (!operationId || !bridge.operationBelongsToSession(operationId)) {
      return {
        kind: "denied",
        code: "browser_turn_not_in_session",
        reason: "The browser request does not belong to this session",
      };
    }
    const actorId = bridge.operationActor(operationId);
    if (!actorId) {
      return {
        kind: "denied",
        code: "browser_actor_missing",
        reason: "The originating turn has no workspace actor",
      };
    }
    if (!(await bridge.authorMayAct(operationId))) {
      return {
        kind: "denied",
        code: "browser_author_no_longer_allowed",
        reason: "The originating turn's author may no longer act on this session",
      };
    }
    if (
      request.action &&
      (PI_BROWSER_SENSITIVE_ACTIONS as readonly string[]).includes(request.action)
    ) {
      // Logging in, uploading, and downloading act on a site that belongs to
      // someone else. They need a human decision, and this session has no
      // approval path for them, so they are refused by name.
      return {
        kind: "denied",
        code: "browser_action_needs_approval",
        reason: "This browser action needs a human approval, which this session does not have",
      };
    }
    if (request.action && !(PI_BROWSER_ACTIONS as readonly string[]).includes(request.action)) {
      return {
        kind: "denied",
        code: "browser_action_not_allowed",
        reason: "The browser may not do that",
      };
    }
    if (!request.url) {
      return {
        kind: "denied",
        code: "browser_url_missing",
        reason: "The browser request does not name a page",
      };
    }
    let hostname: string;
    try {
      const url = new URL(request.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return {
          kind: "denied",
          code: "browser_scheme_not_allowed",
          reason: "The browser may only reach http and https pages",
        };
      }
      hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    } catch {
      return {
        kind: "denied",
        code: "browser_url_invalid",
        reason: "The browser request did not name a page",
      };
    }
    if (!hostMatches(hostname, bridge.allowedDomains())) {
      return {
        kind: "denied",
        code: "browser_domain_not_allowed",
        reason: "The browser may not reach this host",
      };
    }
    return { kind: "allowed", actorId };
  }

  /**
   * Record the decision so collaborators can see what the browser did.
   *
   * Only a request that names the work is recorded. The early gate asks
   * whether the session may drive a browser at all, and that is a policy
   * fact, not browser activity: recording it would put two events on the
   * timeline for one page.
   */
  record(
    request: { action?: string; url?: string },
    operationId: string,
    decision: BrowserAuthorization
  ): void {
    if (!request.action) return;
    this.options.browser.recordActivity({
      operationId,
      actorId: decision.kind === "allowed" ? decision.actorId : "system",
      url: request.url ?? null,
      outcome: decision.kind === "allowed" ? "authorized" : "refused",
      reason: decision.kind === "allowed" ? null : decision.reason,
    });
  }

  /**
   * The internal route the Pi session calls before any browser work.
   *
   * The answer is a decision, never a client: the agent learns whether it may
   * proceed, and the session keeps the authority.
   */
  async authorizeRequest(request: Request): Promise<Response> {
    const operationId = request.headers.get("X-Pi-Operation-ID");
    const parsed = browserRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        {
          allowed: false,
          code: "browser_request_invalid",
          reason: "The browser request is invalid",
        },
        { status: 400 }
      );
    }
    const decision = await this.authorize(parsed.data, operationId);
    if (operationId) this.record(parsed.data, operationId, decision);
    return Response.json(
      decision.kind === "allowed"
        ? { allowed: true }
        : { allowed: false, code: decision.code, reason: decision.reason },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  /**
   * The internal route the Pi session calls to read a page.
   *
   * The session decides and then acts: it authorizes the request, records the
   * decision on the timeline, and only then drives the browser. The agent
   * receives the bounded page and nothing else — no browser client, no
   * session handle, and no provider string.
   */
  async readRequest(request: Request): Promise<Response> {
    const operationId = request.headers.get("X-Pi-Operation-ID");
    const parsed = browserReadRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json(
        {
          allowed: false,
          code: "browser_request_invalid",
          reason: "The browser request is invalid",
        },
        { status: 400 }
      );
    }
    const action = parsed.data.action;
    const url = parsed.data.url;
    const decision = await this.authorize({ action, url }, operationId);
    if (operationId) this.record({ action, url }, operationId, decision);
    if (decision.kind === "denied") {
      return Response.json(
        { allowed: false, code: decision.code, reason: decision.reason },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    // The schema also admits the sensitive actions, so that the gateway can
    // refuse them by name. An allowed action is therefore one the browser
    // offers, and this narrowing says so without an assertion.
    if (!isPiBrowserAction(action)) {
      return Response.json(
        {
          allowed: false,
          code: "browser_action_not_allowed",
          reason: "The browser may not do that",
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    try {
      const outcome = await this.options.browser.read({ action, url });
      return Response.json(
        { allowed: true, outcome },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch {
      // The provider's own string stays inside the platform. The model only
      // learns that the page did not load.
      return Response.json(
        { allowed: false, code: "browser_read_failed", reason: "The page could not be loaded" },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
  }
}

/**
 * Whether one host is inside the reviewed allowlist.
 *
 * A pattern may name one host or a wildcard sub-domain. A wildcard never
 * matches the bare domain, so `*.example.com` does not open `example.com`.
 */
export function hostMatches(hostname: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) return false;
  for (const pattern of allowedDomains) {
    const normalized = pattern.trim().toLowerCase().replace(/^\*\./, ".");
    if (normalized.length === 0) continue;
    if (normalized.startsWith(".")) {
      if (hostname.endsWith(normalized)) return true;
      continue;
    }
    if (hostname === normalized) return true;
  }
  return false;
}
