import { Hono } from "hono";
import { PrAutofixFeedbackStore } from "../db/pr-autofix-feedback-store";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
  type RequestContext,
} from "./shared";

async function handleActivity(request: Request, ctx: RequestContext): Promise<Response> {
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

export const autofixRoutes = new Hono<ControlPlaneHonoEnv>();

autofixRoutes.get(
  "/autofix/activity",
  admit({ ...SCM_AGNOSTIC_WEB_SERVICE_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => handleActivity(c.var.admitted.request, c.var.admitted.ctx)
);
