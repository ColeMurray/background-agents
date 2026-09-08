import { CliAuthStore } from "../db/cli-auth-store";
import { json, type UserRouteContext } from "../routes/shared";
import type { SessionRouteContext } from "../routes/session-route";

const RATE_LIMIT_WINDOW_MS = 60_000;

export async function enforceExternalRateLimit(
  ctx: UserRouteContext | SessionRouteContext,
  bucket: "create" | "mutation" | "events"
): Promise<Response | null> {
  const limits = { create: 30, mutation: 120, events: 600 } as const;
  const userId = ctx.principal?.kind === "user" ? ctx.principal.userId : "unknown";
  const result = await new CliAuthStore(ctx.db).consumeRateLimit({
    key: `external:${bucket}:${userId}`,
    now: Date.now(),
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: limits[bucket],
  });
  if (result.allowed) return null;
  const response = json({ error: "Rate limit exceeded", code: "rate_limited" }, 429);
  response.headers.set("Retry-After", String(Math.ceil(result.retryAfterMs / 1_000)));
  return response;
}
