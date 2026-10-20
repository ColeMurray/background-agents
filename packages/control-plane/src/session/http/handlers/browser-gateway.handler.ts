import { z } from "zod";
import type { FeatureCapabilityMode } from "@open-inspect/shared/pi-feature-capabilities";
import { PI_BROWSER_ACTIONS, PI_BROWSER_SENSITIVE_ACTIONS } from "../../../pi/browser-transport";

/**
 * The browser gateway inside the owning session.
 *
 * The agent proposes browser work. The session authorizes it: the capability
 * must allow it, the deployment mode must allow it, and the pages it may
 * reach must be the ones an operator reviewed. Only then may anything drive
 * a browser, and only for the session that asked.
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
  authorize(
    request: { action?: string; url?: string },
    operationId: string | null
  ): BrowserAuthorization {
    const bridge = this.options.browser;
    if (bridge.sessionCapability() !== "enabled" || bridge.liveMode() !== "enabled") {
      return {
        kind: "denied",
        code: "browser_disabled",
        reason: "Browser work is disabled for this session",
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

  /** Record the decision so collaborators can see what the browser did. */
  record(
    request: { action?: string; url?: string },
    operationId: string,
    decision: BrowserAuthorization
  ): void {
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
    const decision = this.authorize(parsed.data, operationId);
    if (operationId) this.record(parsed.data, operationId, decision);
    return Response.json(
      decision.kind === "allowed"
        ? { allowed: true }
        : { allowed: false, code: decision.code, reason: decision.reason },
      { headers: { "Cache-Control": "no-store" } }
    );
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
