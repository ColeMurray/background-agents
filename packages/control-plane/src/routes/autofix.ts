import { PrAutofixFeedbackStore } from "../db/pr-autofix-feedback-store";
import {
  defineRoutes,
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
  type Route,
} from "./shared";

const handleActivity: Route["handler"] = async (request, _env, _match, ctx) => {
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
};

export const autofixRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_WEB_SERVICE_ROUTE, [
  {
    method: "GET",
    path: "/autofix/activity",
    authorization: NO_AUTHORIZATION,
    handler: handleActivity,
  },
]);
