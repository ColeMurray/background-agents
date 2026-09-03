import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { PrAutofixFeedbackStore } from "../db/pr-autofix-feedback-store";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
  type RequestContext,
} from "./shared";
import { parseQuery } from "./query";

const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 100;
const ACTIVITY_LIMIT_ERROR = `limit must be an integer from 1 to ${MAX_ACTIVITY_LIMIT}`;

const activityQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^[1-9]\d*$/, { error: ACTIVITY_LIMIT_ERROR })
    .optional()
    .transform((raw) => (raw === undefined ? DEFAULT_ACTIVITY_LIMIT : Number(raw)))
    .refine((limit) => limit <= MAX_ACTIVITY_LIMIT, { error: ACTIVITY_LIMIT_ERROR }),
  cursor: z.string().optional(),
});

async function handleActivity(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, activityQuerySchema);
  if (query instanceof Response) return query;

  try {
    return json(
      await new PrAutofixFeedbackStore(ctx.db).listActivity({
        limit: query.limit,
        cursor: query.cursor ?? null,
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
  (c) => dispatch(c, handleActivity)
);
