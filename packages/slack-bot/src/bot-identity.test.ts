import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedModule from "@open-inspect/shared";
import type { Env } from "./types";

const { mockAuthTest } = vi.hoisted(() => ({ mockAuthTest: vi.fn() }));

vi.mock("@open-inspect/shared", async () => {
  const actual = await vi.importActual<typeof SharedModule>("@open-inspect/shared");
  return { ...actual, authTest: mockAuthTest };
});

import { getBotUserId, clearBotUserIdCache } from "./bot-identity";

function makeEnv(kv: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }): Env {
  return {
    SLACK_KV: kv,
    SLACK_BOT_TOKEN: "xoxb-test",
  } as unknown as Env;
}

function emptyKv() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  };
}

describe("getBotUserId", () => {
  beforeEach(() => {
    clearBotUserIdCache();
    vi.clearAllMocks();
  });

  it("resolves the user id via auth.test and persists it to KV", async () => {
    mockAuthTest.mockResolvedValue({ ok: true, user_id: "UBOT123" });
    const kv = emptyKv();

    expect(await getBotUserId(makeEnv(kv))).toBe("UBOT123");
    expect(kv.put).toHaveBeenCalledWith("slack:bot-user-id", "UBOT123");
  });

  it("caches in-process and does not call auth.test twice", async () => {
    mockAuthTest.mockResolvedValue({ ok: true, user_id: "UBOT123" });
    const env = makeEnv(emptyKv());

    await getBotUserId(env);
    await getBotUserId(env);

    expect(mockAuthTest).toHaveBeenCalledTimes(1);
  });

  it("serves the KV last-known-good id when auth.test fails", async () => {
    mockAuthTest.mockResolvedValue({ ok: false, error: "ratelimited" });
    const kv = {
      get: vi.fn().mockResolvedValue("UCACHED"),
      put: vi.fn().mockResolvedValue(undefined),
    };

    expect(await getBotUserId(makeEnv(kv))).toBe("UCACHED");
    expect(kv.get).toHaveBeenCalledWith("slack:bot-user-id");
  });

  it("fails closed (null) when auth.test fails and KV is empty", async () => {
    mockAuthTest.mockResolvedValue({ ok: false, error: "invalid_auth" });
    expect(await getBotUserId(makeEnv(emptyKv()))).toBeNull();
  });

  it("fails closed (null) when auth.test succeeds without a user_id", async () => {
    mockAuthTest.mockResolvedValue({ ok: true });
    expect(await getBotUserId(makeEnv(emptyKv()))).toBeNull();
  });
});
