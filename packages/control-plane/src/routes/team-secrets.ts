import { Hono } from "hono";
import { TeamSecretsStore } from "../db/team-secrets";
import { SecretsValidationError, normalizeKey } from "../db/secrets-validation";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { secretsRequestBodySchema } from "./secret-request-schemas";
import {
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  error,
  json,
  requireTeam,
  type UserRouteContext,
} from "./shared";

const logger = createLogger("router:team-secrets");

function secretsStore(env: Env, ctx: UserRouteContext): TeamSecretsStore | Response {
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }
  return new TeamSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);
}

function secretsError(cause: unknown, teamId: string, ctx: UserRouteContext): Response {
  if (cause instanceof SecretsValidationError) return error(cause.message, 400);
  // Storage errors can contain bound values; never include their contents in logs or responses.
  logger.error("Team secrets storage unavailable", {
    team_id: teamId,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return error("Secrets storage unavailable", 503);
}

async function listSecrets(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const store = secretsStore(env, ctx);
  if (store instanceof Response) return store;
  try {
    return json({ teamId: params.id, secrets: await store.listSecretKeys(params.id) });
  } catch (cause) {
    return secretsError(cause, params.id, ctx);
  }
}

async function setSecrets(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const store = secretsStore(env, ctx);
  if (store instanceof Response) return store;
  const body = await parseBody(
    request,
    secretsRequestBodySchema,
    "Request body must include secrets object"
  );
  if (body instanceof Response) return body;
  try {
    const result = await store.setSecrets(params.id, body.secrets, {
      requestId: ctx.request_id,
      actorUserId: ctx.principal.userId,
    });
    return json({ status: "updated", teamId: params.id, ...result });
  } catch (cause) {
    return secretsError(cause, params.id, ctx);
  }
}

async function deleteSecret(
  _request: Request,
  env: Env,
  params: { id: string; key: string },
  ctx: UserRouteContext
): Promise<Response> {
  const store = secretsStore(env, ctx);
  if (store instanceof Response) return store;
  try {
    const deleted = await store.deleteSecret(params.id, params.key, {
      requestId: ctx.request_id,
      actorUserId: ctx.principal.userId,
    });
    if (!deleted) return error("Secret not found", 404);
    return json({ status: "deleted", teamId: params.id, key: normalizeKey(params.key) });
  } catch (cause) {
    return secretsError(cause, params.id, ctx);
  }
}

const manageSecrets = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requireTeam("canManageSecrets"),
  cacheControl: "private, no-store",
});

export const teamSecretsRoutes = new Hono<ControlPlaneHonoEnv>();
teamSecretsRoutes.get("/teams/:id/secrets", manageSecrets, (c) => dispatch(c, listSecrets));
teamSecretsRoutes.put("/teams/:id/secrets", manageSecrets, (c) => dispatch(c, setSecrets));
teamSecretsRoutes.delete("/teams/:id/secrets/:key", manageSecrets, (c) =>
  dispatch(c, deleteSecret)
);
