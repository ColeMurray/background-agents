import { PrAutofixFeedbackStore } from "../db/pr-autofix-feedback-store";
import type { Env } from "../types";
import type { Route } from "./shared";
import { error, json, parsePattern, type RequestContext } from "./shared";

async function handleActivity(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (ctx.principal?.kind !== "service" || ctx.principal.service !== "web") {
    return error("Unauthorized", 401);
  }

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit") ?? "50";
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return error("limit must be an integer from 1 to 100", 400);
  }

  try {
    return json(
      await new PrAutofixFeedbackStore(ctx.db).listActivity({
        limit,
        cursor: url.searchParams.get("cursor"),
      })
    );
  } catch (caught) {
    if (caught instanceof Error && caught.message === "Invalid Autofix activity cursor") {
      return error(caught.message, 400);
    }
    throw caught;
  }
}

export const autofixRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/autofix/activity"),
    handler: handleActivity,
  },
];
