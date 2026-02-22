import { DEFAULT_THEME_ID } from "../theme";
import { UserPreferencesStore, UserPreferencesValidationError } from "../db/user-preferences";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:user-preferences");

function extractUserId(match: RegExpMatchArray): string | null {
  const userId = match.groups?.userId;
  if (!userId) return null;
  return decodeURIComponent(userId);
}

async function handleGetUserPreferences(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const userId = extractUserId(match);
  if (!userId) return error("userId is required", 400);

  if (!env.DB) {
    return json({ userId, theme: DEFAULT_THEME_ID });
  }

  const store = new UserPreferencesStore(env.DB);
  const theme = await store.getTheme(userId);
  return json({ userId, theme: theme ?? DEFAULT_THEME_ID });
}

async function handleSetUserPreferences(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const userId = extractUserId(match);
  if (!userId) return error("userId is required", 400);

  if (!env.DB) {
    return error("User preferences storage is not configured", 503);
  }

  let body: { theme?: string };
  try {
    body = (await request.json()) as { theme?: string };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body?.theme || typeof body.theme !== "string") {
    return error("Request body must include theme", 400);
  }

  const store = new UserPreferencesStore(env.DB);

  try {
    const theme = await store.setTheme(userId, body.theme);

    logger.info("user_preferences.updated", {
      event: "user_preferences.updated",
      user_id: userId,
      theme,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", userId, theme });
  } catch (e) {
    if (e instanceof UserPreferencesValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update user preferences", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("User preferences storage unavailable", 503);
  }
}

export const userPreferencesRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/user-preferences/:userId"),
    handler: handleGetUserPreferences,
  },
  {
    method: "PUT",
    pattern: parsePattern("/user-preferences/:userId"),
    handler: handleSetUserPreferences,
  },
];
