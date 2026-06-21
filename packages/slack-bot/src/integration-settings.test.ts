import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "./types";
import { getAllowPrivateChannels, resetSlackSettingsCache } from "./integration-settings";

function createMockKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function makeEnv(
  controlPlaneFetch: (input: RequestInfo | URL) => Promise<Response>,
  kv = createMockKV()
): { env: Env; kv: ReturnType<typeof createMockKV> } {
  const env = {
    SLACK_KV: kv as unknown as KVNamespace,
    CONTROL_PLANE: { fetch: vi.fn(controlPlaneFetch) } as unknown as Fetcher,
    CONTROL_PLANE_URL: "https://control-plane.test",
    INTERNAL_CALLBACK_SECRET: "secret",
    LOG_LEVEL: "error",
  } as unknown as Env;
  return { env, kv };
}

function settingsResponse(allowPrivateChannels?: boolean): Response {
  return new Response(
    JSON.stringify({
      integrationId: "slack",
      settings: allowPrivateChannels === undefined ? null : { defaults: { allowPrivateChannels } },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("getAllowPrivateChannels", () => {
  beforeEach(() => {
    resetSlackSettingsCache();
  });

  it("returns true (allow) when no settings are stored", async () => {
    const { env } = makeEnv(async () => settingsResponse(undefined));
    expect(await getAllowPrivateChannels(env)).toBe(true);
  });

  it("returns the configured value and writes it to the last-known-good KV key", async () => {
    const { env, kv } = makeEnv(async () => settingsResponse(false));
    expect(await getAllowPrivateChannels(env)).toBe(false);
    expect(kv.store.get("slack_settings:allow_private_channels")).toBe("false");
  });

  it("latches a previously-fetched deny when the control plane is unreachable", async () => {
    const kv = createMockKV({ "slack_settings:allow_private_channels": "false" });
    const { env } = makeEnv(async () => {
      throw new Error("control plane down");
    }, kv);
    // Even though the fetch fails, a known deny stays a deny.
    expect(await getAllowPrivateChannels(env)).toBe(false);
  });

  it("latches a previously-fetched deny on a non-ok response", async () => {
    const kv = createMockKV({ "slack_settings:allow_private_channels": "false" });
    const { env } = makeEnv(async () => new Response("nope", { status: 503 }), kv);
    expect(await getAllowPrivateChannels(env)).toBe(false);
  });

  it("falls back to allow when the fetch fails and nothing was ever known", async () => {
    const { env } = makeEnv(async () => {
      throw new Error("control plane down");
    });
    expect(await getAllowPrivateChannels(env)).toBe(true);
  });

  it("does not cache the permissive default on the error path (picks up recovery)", async () => {
    let calls = 0;
    const { env } = makeEnv(async () => {
      calls += 1;
      if (calls === 1) throw new Error("down");
      return settingsResponse(false); // control plane recovers, operator had set deny
    });
    expect(await getAllowPrivateChannels(env)).toBe(true); // error, nothing known → default
    expect(await getAllowPrivateChannels(env)).toBe(false); // recovered → deny picked up immediately
  });

  it("caches the resolved value in memory for subsequent calls", async () => {
    const fetchImpl = vi.fn(async () => settingsResponse(false));
    const { env } = makeEnv(fetchImpl);
    await getAllowPrivateChannels(env);
    await getAllowPrivateChannels(env);
    // Second call served from the in-memory cache — only one control-plane fetch.
    expect((env.CONTROL_PLANE.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
