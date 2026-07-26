import { hashToken } from "../auth/crypto";
import {
  OAuthRateLimitExceededError,
  type OAuthProtocolRateLimiter,
  type OAuthProtocolEventSink,
} from "./oauth";

const OAUTH_RATE_LIMIT_RETRY_SECONDS = 60;

export interface OAuthRateLimiterDependencies {
  readonly hashSource: (source: string) => Promise<string>;
}

const defaultDependencies: OAuthRateLimiterDependencies = {
  hashSource: hashToken,
};

export class CloudflareOAuthRateLimiter implements OAuthProtocolRateLimiter {
  constructor(
    private readonly events: OAuthProtocolEventSink,
    private readonly dependencies: OAuthRateLimiterDependencies = defaultDependencies
  ) {}

  async requireAllowance(input: Parameters<OAuthProtocolRateLimiter["requireAllowance"]>[0]) {
    if (!input.env.AUTH_RATE_LIMITER) {
      this.events.emit(
        "auth.oauth.rate_limiter_unavailable",
        {
          route_class: input.routeClass,
          failure: "binding_missing",
          request_id: input.requestId,
          trace_id: input.traceId,
        },
        "warn"
      );
      return;
    }

    const source = input.request.headers.get("CF-Connecting-IP") ?? "unknown";
    let result: { success: boolean };
    try {
      const sourceHash = await this.dependencies.hashSource(`oauth-source:${source}`);
      result = await input.env.AUTH_RATE_LIMITER.limit({
        key: `${input.routeClass}:${input.clientId}:${sourceHash}`,
      });
    } catch (error) {
      this.events.emit(
        "auth.oauth.rate_limiter_unavailable",
        {
          route_class: input.routeClass,
          failure: error instanceof Error ? error.name : "unknown",
          request_id: input.requestId,
          trace_id: input.traceId,
        },
        "warn"
      );
      return;
    }
    if (!result.success) {
      throw new OAuthRateLimitExceededError(OAUTH_RATE_LIMIT_RETRY_SECONDS);
    }
  }
}
