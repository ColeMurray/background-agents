import { TOKEN_VALIDITY_MS, verifyCallbackFromControlPlane } from "@open-inspect/shared/auth";
import { getChannelInfo } from "@open-inspect/shared/slack";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";

const channelInfoRequestSchema = z.object({
  channelId: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
  signature: z.string().min(1),
});

export const channelInfoRoutes = new Hono<{ Bindings: Env }>();

channelInfoRoutes.post("/internal/channel-info", async (c) => {
  const parsed = channelInfoRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400);
  if (!c.env.SERVICE_AUTH_SECRET) return c.json({ error: "not configured" }, 500);
  if (!(await verifyCallbackFromControlPlane(parsed.data, c.env))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { channelId, timestamp } = parsed.data;
  if (Math.abs(Date.now() - timestamp) > TOKEN_VALIDITY_MS) {
    return c.json({ error: "unauthorized" }, 401);
  }
  try {
    const result = await getChannelInfo(c.env.SLACK_BOT_TOKEN, channelId);
    if (!result.ok) {
      return c.json(
        { error: "channel unavailable" },
        result.error === "channel_not_found" ? 404 : 502
      );
    }
    const channel = result.channel;
    if (typeof channel.is_member !== "boolean" || typeof channel.is_ext_shared !== "boolean") {
      return c.json({ error: "channel unavailable" }, 502);
    }
    return c.json({
      id: channel.id,
      name: channel.name,
      isMember: channel.is_member,
      isExtShared: channel.is_ext_shared,
    });
  } catch {
    return c.json({ error: "channel unavailable" }, 502);
  }
});
