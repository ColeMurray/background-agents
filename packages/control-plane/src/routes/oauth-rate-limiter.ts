import { hashToken } from "../auth/crypto";
import {
  OAuthRateLimitExceededError,
  type OAuthProtocolRateLimiter,
  type OAuthProtocolEventSink,
} from "./oauth";

export interface OAuthRateLimiterDependencies {
  readonly hashSource: (source: string) => Promise<string>;
}

const defaultDependencies: OAuthRateLimiterDependencies = {
  hashSource: hashToken,
};

type OAuthRateLimitInput = Parameters<OAuthProtocolRateLimiter["requireAllowance"]>[0];

function rateLimitWindowSeconds(env: OAuthRateLimitInput["env"]): 10 | 60 | null {
  const value = Number(env.AUTH_RATE_LIMIT_WINDOW_SECONDS);
  return value === 10 || value === 60 ? value : null;
}

function emitUnavailable(
  events: OAuthProtocolEventSink,
  input: OAuthRateLimitInput,
  failure: string
): void {
  events.emit(
    "auth.oauth.rate_limiter_unavailable",
    {
      route_class: input.routeClass,
      failure,
      request_id: input.requestId,
      trace_id: input.traceId,
    },
    "warn"
  );
}

export class CloudflareOAuthRateLimiter implements OAuthProtocolRateLimiter {
  constructor(
    private readonly events: OAuthProtocolEventSink,
    private readonly dependencies: OAuthRateLimiterDependencies = defaultDependencies
  ) {}

  async requireAllowance(input: OAuthRateLimitInput) {
    if (!input.env.AUTH_RATE_LIMITER) {
      emitUnavailable(this.events, input, "binding_missing");
      return;
    }

    const windowSeconds = rateLimitWindowSeconds(input.env);
    if (windowSeconds === null) {
      emitUnavailable(this.events, input, "window_configuration_invalid");
      return;
    }

    const source = input.request.headers.get("CF-Connecting-IP");
    if (!source) {
      emitUnavailable(this.events, input, "source_missing");
      return;
    }

    let result: { success: boolean };
    try {
      const sourceHash = await this.dependencies.hashSource(`oauth-source:${source}`);
      result = await input.env.AUTH_RATE_LIMITER.limit({
        key: `${input.routeClass}:${input.clientId}:${sourceHash}`,
      });
    } catch (error) {
      emitUnavailable(this.events, input, error instanceof Error ? error.name : "unknown");
      return;
    }
    if (!result.success) {
      throw new OAuthRateLimitExceededError(windowSeconds);
    }
  }
}
