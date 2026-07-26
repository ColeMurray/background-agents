import { createOAuthProtocolRuntime } from "../auth/oauth-runtime-composition";
import { createLogger } from "../logger";
import { createOAuthProtocolRoutes, type OAuthProtocolEventSink } from "./oauth";
import { CloudflareOAuthRateLimiter } from "./oauth-rate-limiter";

const logger = createLogger("oauth");

const events: OAuthProtocolEventSink = {
  emit(event, fields = {}, level = "info"): void {
    logger[level](event, { ...fields, event });
  },
};

/**
 * Fully composed OAuth protocol routes. They remain inactive until the
 * router gains the final closed, per-route authentication declarations; the
 * legacy path classifier cannot safely express these mixed public/service
 * endpoints.
 */
export const oauthProtocolRoutes = createOAuthProtocolRoutes({
  createRuntime: createOAuthProtocolRuntime,
  rateLimiter: new CloudflareOAuthRateLimiter(events),
  events,
});
