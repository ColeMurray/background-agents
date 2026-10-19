import { Hono } from "hono";
import {
  slackIngressAdmitSchema,
  slackIngressClaimSchema,
  slackIngressTransitionSchema,
} from "@open-inspect/shared";
import { SlackIngressStore } from "../db/slack-ingress";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { json, serviceAuthorized, type RequestContext } from "./shared";
import type { Env } from "../types";

const POLICY = {
  authentication: { kind: "service" as const },
  supportedScmProviders: "all" as const,
  authorization: serviceAuthorized("slack-bot"),
  cacheControl: "private, no-store" as const,
};
function slackOnly(ctx: RequestContext) {
  const principal = ctx.principal;
  return principal?.kind === "service" && principal.service === "slack-bot";
}
async function body(request: Request) {
  return request.json().catch(() => null);
}
export const slackIngressRoutes = new Hono<ControlPlaneHonoEnv>();
slackIngressRoutes.post("/internal/slack-ingress", admit(POLICY), (c) =>
  dispatch(c, async (request: Request, _env: Env, _p: object, ctx: RequestContext) => {
    if (!slackOnly(ctx)) return json({ error: "Forbidden" }, 403);
    const parsed = slackIngressAdmitSchema.safeParse(await body(request));
    if (!parsed.success) return json({ error: "Invalid Slack ingress receipt" }, 400);
    try {
      const admitted = await new SlackIngressStore(ctx.db).admit(parsed.data, Date.now());
      return json(
        { receipt: admitted.row, created: admitted.created },
        admitted.created ? 201 : 200
      );
    } catch {
      return json({ error: "Slack ingress conflict" }, 409);
    }
  })
);
slackIngressRoutes.post("/internal/slack-ingress/:id/claim", admit(POLICY), (c) =>
  dispatch(c, async (request, _env, p: { id: string }, ctx) => {
    if (!slackOnly(ctx)) return json({ error: "Forbidden" }, 403);
    const parsed = slackIngressClaimSchema.safeParse(await body(request));
    if (!parsed.success) return json({ error: "Invalid claim" }, 400);
    const receipt = await new SlackIngressStore(ctx.db).claim(
      p.id,
      parsed.data.leaseOwner,
      parsed.data.leaseMs,
      Date.now()
    );
    return receipt ? json({ receipt }) : json({ error: "Not claimable" }, 409);
  })
);
slackIngressRoutes.post("/internal/slack-ingress/:id/transition", admit(POLICY), (c) =>
  dispatch(c, async (request, _env, p: { id: string }, ctx) => {
    if (!slackOnly(ctx)) return json({ error: "Forbidden" }, 403);
    const parsed = slackIngressTransitionSchema.safeParse(await body(request));
    if (!parsed.success) return json({ error: "Invalid transition" }, 400);
    const v = parsed.data;
    const receipt = await new SlackIngressStore(ctx.db).transition(
      p.id,
      v.leaseOwner,
      v.expectedState,
      v.state,
      v.sessionId,
      v.errorCode,
      Date.now()
    );
    return receipt ? json({ receipt }) : json({ error: "Transition conflict" }, 409);
  })
);
slackIngressRoutes.get("/internal/slack-ingress/:id", admit(POLICY), (c) =>
  dispatch(c, async (_r, _e, p: { id: string }, ctx) => {
    if (!slackOnly(ctx)) return json({ error: "Forbidden" }, 403);
    const receipt = await new SlackIngressStore(ctx.db).get(p.id);
    return receipt ? json({ receipt }) : json({ error: "Not found" }, 404);
  })
);
slackIngressRoutes.post("/internal/slack-ingress/reconcile", admit(POLICY), (c) =>
  dispatch(c, async (_r, _e, _p, ctx) => {
    if (!slackOnly(ctx)) return json({ error: "Forbidden" }, 403);
    const store = new SlackIngressStore(ctx.db);
    const now = Date.now();
    const [leases, cleanup] = await Promise.all([
      store.reconcile(now),
      store.cleanup(now - 7 * 24 * 60 * 60 * 1000),
    ]);
    return json({ reconciled: leases.meta.changes, deleted: cleanup });
  })
);
