import { Hono } from "hono";
import { z } from "zod";
import { computeHmacHex } from "@open-inspect/shared/auth";
import {
  putTeamChannelBindingRequestSchema,
  teamChannelBindingProviderSchema,
  teamChannelBindingResponseSchema,
  teamChannelBindingsResponseSchema,
} from "@open-inspect/shared/types/team-channel-bindings";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import {
  TeamChannelBindingConflictError,
  TeamChannelBindingStore,
} from "../db/team-channel-bindings";
import type { RequestContext } from "../http/request-context";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { handleGetSlackChannels } from "./automation-slack-settings";
import { SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, error, json, requireTeam } from "./shared";

const slackChannelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  isMember: z.boolean(),
  isExtShared: z.boolean(),
});

function admittedTeamId(ctx: RequestContext): string {
  if (!ctx.teamAdmission) throw new Error("Team route not admitted");
  return ctx.teamAdmission.team.id;
}

async function listBindings(
  _request: Request,
  _env: Env,
  _params: { id: string },
  ctx: RequestContext
) {
  return json(
    teamChannelBindingsResponseSchema.parse({
      bindings: await new TeamChannelBindingStore(ctx.db).listByTeam(admittedTeamId(ctx)),
    })
  );
}

async function putBinding(
  request: Request,
  env: Env,
  params: { id: string; provider: string; externalId: string },
  ctx: RequestContext
) {
  if (params.provider !== "slack") return error("Unsupported channel binding provider", 400);
  const body = await parseBody(request, putTeamChannelBindingRequestSchema);
  if (body instanceof Response) return body;
  const secret = callbackSigningSecret(env, "slack-bot");
  if (!env.SLACK_BOT || !secret) {
    return json(
      { error: "Channel information unavailable", code: "channel_info_unavailable" },
      503
    );
  }

  const payload = { channelId: params.externalId, timestamp: Date.now() };
  const signature = await computeHmacHex(JSON.stringify(payload), secret);
  let response: Response;
  try {
    response = await env.SLACK_BOT.fetch("https://internal/internal/channel-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, signature }),
      signal: request.signal,
    });
  } catch {
    return json(
      { error: "Channel information unavailable", code: "channel_info_unavailable" },
      503
    );
  }
  const info = slackChannelInfoSchema.safeParse(
    response.ok ? await response.json().catch(() => null) : null
  );
  if (
    !info.success ||
    info.data.id !== params.externalId ||
    !info.data.isMember ||
    info.data.isExtShared
  ) {
    return json({ error: "Channel cannot be bound", code: "channel_not_joinable" }, 409);
  }

  if (ctx.principal?.kind !== "user") throw new Error("Team route not admitted");
  try {
    const binding = await new TeamChannelBindingStore(ctx.db).put(
      {
        teamId: admittedTeamId(ctx),
        provider: "slack",
        externalId: params.externalId,
        kind: body.kind,
      },
      { requestId: ctx.request_id, actorUserId: ctx.principal.userId }
    );
    return json(teamChannelBindingResponseSchema.parse({ binding }));
  } catch (cause) {
    if (cause instanceof TeamChannelBindingConflictError) {
      return json({ error: cause.message, code: "channel_binding_conflict" }, 409);
    }
    throw cause;
  }
}

async function deleteBinding(
  _request: Request,
  _env: Env,
  params: { id: string; provider: string; externalId: string },
  ctx: RequestContext
) {
  const provider = teamChannelBindingProviderSchema.safeParse(params.provider);
  if (!provider.success) return error("Unsupported channel binding provider", 400);
  if (ctx.principal?.kind !== "user") throw new Error("Team route not admitted");
  await new TeamChannelBindingStore(ctx.db).remove(
    admittedTeamId(ctx),
    provider.data,
    params.externalId,
    { requestId: ctx.request_id, actorUserId: ctx.principal.userId }
  );
  return new Response(null, { status: 204 });
}

export const teamChannelBindingRoutes = new Hono<ControlPlaneHonoEnv>();
const manageBindings = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  cacheControl: "private, no-store",
  authorization: requireTeam("canManageBindings"),
});

teamChannelBindingRoutes.get("/teams/:id/channel-bindings", manageBindings, (c) =>
  dispatch(c, listBindings)
);
teamChannelBindingRoutes.put(
  "/teams/:id/channel-bindings/:provider/:externalId",
  manageBindings,
  (c) => dispatch(c, putBinding)
);
teamChannelBindingRoutes.delete(
  "/teams/:id/channel-bindings/:provider/:externalId",
  manageBindings,
  (c) => dispatch(c, deleteBinding)
);
teamChannelBindingRoutes.get("/teams/:id/slack-channels", manageBindings, (c) =>
  dispatch(c, handleGetSlackChannels)
);
