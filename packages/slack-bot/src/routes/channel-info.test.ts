import { afterEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import app from "../app";
import type { Env } from "../types";
import { makeExecutionContext } from "../test-helpers";

const env = {
  SERVICE_AUTH_SECRET: "callback-secret",
  SLACK_SIGNING_SECRET: "slack-secret",
  SLACK_BOT_TOKEN: "own-bot-token",
} as Env;
async function request(
  data: { channelId: string; timestamp: number },
  secret = "callback-secret",
  bindings = env
) {
  return app.fetch(
    new Request("https://bot/internal/channel-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...data,
        signature: await computeHmacHex(JSON.stringify(data), secret),
      }),
    }),
    bindings,
    makeExecutionContext()
  );
}

describe("POST /internal/channel-info", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { is_member: true, is_ext_shared: false },
    { is_member: false, is_ext_shared: false },
    { is_member: true, is_ext_shared: true },
  ])("uses its own Slack token and faithfully returns validation flags: %j", async (flags) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ok: true,
        channel: { id: "C123", name: "eng", ...flags },
      })
    );
    const response = await request({ channelId: "C123", timestamp: Date.now() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "C123",
      name: "eng",
      isMember: flags.is_member,
      isExtShared: flags.is_ext_shared,
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("conversations.info"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer own-bot-token" }),
      })
    );
  });

  it.each([-10 * 60 * 1000, 10 * 60 * 1000])(
    "rejects timestamps outside the window: %s",
    async (offset) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      expect((await request({ channelId: "C123", timestamp: Date.now() + offset })).status).toBe(
        401
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("does not accept the Slack webhook signing secret as callback authentication", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await request(
      { channelId: "C123", timestamp: Date.now() },
      env.SLACK_SIGNING_SECRET
    );
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires SERVICE_AUTH_SECRET even when the Slack webhook signing secret is configured", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await request(
      { channelId: "C123", timestamp: Date.now() },
      "callback-secret",
      {
        ...env,
        SERVICE_AUTH_SECRET: "",
      }
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "not configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when Slack cannot resolve the channel", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: false, error: "channel_not_found" })
    );
    expect((await request({ channelId: "C123", timestamp: Date.now() })).status).toBe(404);
  });

  it.each(["is_member", "is_ext_shared"])(
    "does not infer safety when Slack omits %s",
    async (flag) => {
      const channel: Record<string, unknown> = {
        id: "C123",
        name: "eng",
        is_member: true,
        is_ext_shared: false,
      };
      delete channel[flag];
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, channel }));
      expect((await request({ channelId: "C123", timestamp: Date.now() })).status).toBe(502);
    }
  );
});
