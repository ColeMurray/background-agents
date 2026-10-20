import type { PiToolPolicyDelegate } from "./tool-policy-extension";

/** The browser tool's stable name. */
export const BROWSER_TOOL_NAME = "browser";

/**
 * The session's answer to "may this turn drive a browser?".
 *
 * The session owns the decision. The agent learns only whether it may
 * proceed and why not; it never receives a browser client.
 */
export interface BrowserAuthorizationDecision {
  allowed: boolean;
  code?: string;
  reason?: string;
}

export interface BrowserAuthorizationClient {
  authorize(
    request: { action?: string; url?: string },
    signal?: AbortSignal
  ): Promise<BrowserAuthorizationDecision>;
}

export interface BrowserPolicyOptions {
  client: BrowserAuthorizationClient;
}

/**
 * The browser policy.
 *
 * A browser is a capability with real reach, so the owning session decides
 * whether this turn may use it. The decision is per call, and it is refused
 * the moment the deployment or the session says no.
 */
export function createBrowserPolicyDelegate(options: BrowserPolicyOptions): PiToolPolicyDelegate {
  return {
    async beforeTool(call, declaration, _api, context) {
      if (call.name !== BROWSER_TOOL_NAME) return undefined;
      if (declaration.effect !== "external_mutation") return undefined;
      let decision: BrowserAuthorizationDecision;
      try {
        // The early gate asks whether this turn may drive a browser at
        // all, before any work is named. The work itself is authorized by
        // the tool, once, and that is the call the timeline records.
        decision = await options.client.authorize(
          {
            url: typeof call.arguments.url === "string" ? call.arguments.url : undefined,
          },
          context.abortSignal
        );
      } catch (error) {
        return {
          block:
            error instanceof Error
              ? error.message
              : "The browser could not be authorized for this session",
        };
      }
      if (decision.allowed) return undefined;
      return { block: decision.reason ?? "The browser is not available for this session" };
    },
  };
}
