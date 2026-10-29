import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SlackModule from "@open-inspect/shared/slack";
import type { Env } from "./types";

const { mockAuthTest } = vi.hoisted(() => ({ mockAuthTest: vi.fn() }));

vi.mock("@open-inspect/shared/slack", async () => {
  const actual = await vi.importActual<typeof SlackModule>("@open-inspect/shared/slack");
  return { ...actual, authTest: mockAuthTest };
});

import { getBotIdentity, clearBotIdentityCache } from "./bot-identity";

function makeEnv(kv: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }): Env {
  return {
    SLACK_KV: kv,
    SLACK_BOT_TOKEN: "xoxb-test",
  } as unknown as Env;
}

function kvWith(stored: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => stored[key] ?? null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe("getBotIdentity", () => {
  beforeEach(() => {
    clearBotIdentityCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves both ids from one auth.test call and persists them to KV", async () => {
    mockAuthTest.mockResolvedValue({ ok: true, user_id: "UBOT123", bot_id: "BBOT123" });
    const kv = kvWith();

    expect(await getBotIdentity(makeEnv(kv))).toEqual({ userId: "UBOT123", botId: "BBOT123" });
    expect(kv.put).toHaveBeenCalledWith("slack:bot-user-id", "UBOT123");
    expect(kv.put).toHaveBeenCalledWith("slack:bot-id", "BBOT123");
  });

  it("caches in-process and does not call auth.test twice", async () => {
    mockAuthTest.mockResolvedValue({ ok: true, user_id: "UBOT123", bot_id: "BBOT123" });
    const env = makeEnv(kvWith());

    await getBotIdentity(env);
    await getBotIdentity(env);

    expect(mockAuthTest).toHaveBeenCalledTimes(1);
  });

  it("keeps a complete identity for the hour", async () => {
    mockAuthTest.mockResolvedValue({ ok: true, user_id: "UBOT123", bot_id: "BBOT123" });
    const env = makeEnv(kvWith());
    const now = vi.spyOn(Date, "now").mockReturnValue(0);

    await getBotIdentity(env);
    now.mockReturnValue(59 * 60 * 1000);
    await getBotIdentity(env);

    expect(mockAuthTest).toHaveBeenCalledTimes(1);
  });

  it("retries an identity without a bot id after a minute, serving its user id meanwhile", async () => {
    mockAuthTest.mockResolvedValue({ ok: false, error: "ratelimited" });
    const env = makeEnv(kvWith({ "slack:bot-user-id": "UCACHED" }));
    const now = vi.spyOn(Date, "now").mockReturnValue(0);

    expect(await getBotIdentity(env)).toEqual({ userId: "UCACHED", botId: null });
    now.mockReturnValue(30 * 1000);
    expect(await getBotIdentity(env)).toEqual({ userId: "UCACHED", botId: null });
    expect(mockAuthTest).toHaveBeenCalledTimes(1);

    mockAuthTest.mockResolvedValue({ ok: true, user_id: "UBOT123", bot_id: "BBOT123" });
    now.mockReturnValue(61 * 1000);
    expect(await getBotIdentity(env)).toEqual({ userId: "UBOT123", botId: "BBOT123" });
    expect(mockAuthTest).toHaveBeenCalledTimes(2);
  });

  it("reports an unknown bot id as null without persisting one", async () => {
    mockAuthTest.mockResolvedValue({ ok: true, user_id: "UBOT123" });
    const kv = kvWith();

    expect(await getBotIdentity(makeEnv(kv))).toEqual({ userId: "UBOT123", botId: null });
    expect(kv.put).toHaveBeenCalledExactlyOnceWith("slack:bot-user-id", "UBOT123");
    // A bot id stored earlier is cleared, so a later KV fallback cannot pair it
    // with this user id.
    expect(kv.delete).toHaveBeenCalledExactlyOnceWith("slack:bot-id");
  });

  it("still returns the identity when persisting it to KV fails", async () => {
    mockAuthTest.mockResolvedValue({ ok: true, user_id: "UBOT123", bot_id: "BBOT123" });
    const kv = kvWith();
    kv.put.mockRejectedValue(new Error("kv down"));

    expect(await getBotIdentity(makeEnv(kv))).toEqual({ userId: "UBOT123", botId: "BBOT123" });
  });

  it("serves the KV last-known-good ids when auth.test fails", async () => {
    mockAuthTest.mockResolvedValue({ ok: false, error: "ratelimited" });
    const kv = kvWith({ "slack:bot-user-id": "UCACHED", "slack:bot-id": "BCACHED" });

    expect(await getBotIdentity(makeEnv(kv))).toEqual({ userId: "UCACHED", botId: "BCACHED" });
  });

  it("serves a KV user id without a bot id, leaving the bot id unknown", async () => {
    mockAuthTest.mockResolvedValue({ ok: false, error: "ratelimited" });
    const kv = kvWith({ "slack:bot-user-id": "UCACHED" });

    expect(await getBotIdentity(makeEnv(kv))).toEqual({ userId: "UCACHED", botId: null });
  });

  it("serves the KV user id when only the bot id cannot be read", async () => {
    mockAuthTest.mockResolvedValue({ ok: false, error: "ratelimited" });
    const kv = kvWith({ "slack:bot-user-id": "UCACHED" });
    kv.get.mockImplementation(async (key: string) => {
      if (key === "slack:bot-id") throw new Error("kv read failed");
      return "UCACHED";
    });

    expect(await getBotIdentity(makeEnv(kv))).toEqual({ userId: "UCACHED", botId: null });
  });

  it("fails closed (null) when the KV user id cannot be read", async () => {
    mockAuthTest.mockResolvedValue({ ok: false, error: "ratelimited" });
    const kv = kvWith({ "slack:bot-id": "BCACHED" });
    kv.get.mockImplementation(async (key: string) => {
      if (key === "slack:bot-user-id") throw new Error("kv read failed");
      return "BCACHED";
    });

    expect(await getBotIdentity(makeEnv(kv))).toBeNull();
  });

  it("fails closed (null) when auth.test fails and KV is empty", async () => {
    mockAuthTest.mockResolvedValue({ ok: false, error: "invalid_auth" });
    expect(await getBotIdentity(makeEnv(kvWith()))).toBeNull();
  });

  it("fails closed (null) when auth.test succeeds without a user_id", async () => {
    mockAuthTest.mockResolvedValue({ ok: true });
    expect(await getBotIdentity(makeEnv(kvWith()))).toBeNull();
  });
});
