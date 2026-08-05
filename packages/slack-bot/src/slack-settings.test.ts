import { describe, expect, it, vi } from "vitest";
import type { Env } from "./types";
import { getSlackSettings } from "./slack-settings";

function makeEnv(fetch: ReturnType<typeof vi.fn>): Env {
  return {
    SERVICE_AUTH_SECRET: "test-secret",
    CONTROL_PLANE: { fetch },
  } as unknown as Env;
}

function settingsResponse(defaults: Record<string, unknown>) {
  return new Response(JSON.stringify({ settings: { defaults } }));
}

describe("getSlackSettings", () => {
  it("returns the default model and session instructions from one fetch", async () => {
    const fetch = vi.fn().mockResolvedValue(
      settingsResponse({
        model: "anthropic/claude-sonnet-4-6",
        sessionInstructions: "Prefer minimal diffs.",
      })
    );

    await expect(getSlackSettings(makeEnv(fetch))).resolves.toEqual({
      defaultModel: "anthropic/claude-sonnet-4-6",
      sessionInstructions: "Prefer minimal diffs.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("drops an invalid default model", async () => {
    const fetch = vi.fn().mockResolvedValue(settingsResponse({ model: "not-a-model" }));

    const config = await getSlackSettings(makeEnv(fetch));
    expect(config.defaultModel).toBeUndefined();
  });

  it("returns no instructions when unset", async () => {
    const fetch = vi.fn().mockResolvedValue(settingsResponse({}));

    const config = await getSlackSettings(makeEnv(fetch));
    expect(config.sessionInstructions).toBeUndefined();
  });

  it("returns an empty config when settings are null", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ settings: null })));

    await expect(getSlackSettings(makeEnv(fetch))).resolves.toEqual({});
  });

  it("returns an empty config on a malformed settings response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ settings: { defaults: { model: 123 } } })));

    await expect(getSlackSettings(makeEnv(fetch))).resolves.toEqual({});
  });

  it("returns no instructions when whitespace-only", async () => {
    const fetch = vi.fn().mockResolvedValue(settingsResponse({ sessionInstructions: "   \n" }));

    const config = await getSlackSettings(makeEnv(fetch));
    expect(config.sessionInstructions).toBeUndefined();
  });

  it("returns an empty config on a non-OK response", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));

    await expect(getSlackSettings(makeEnv(fetch))).resolves.toEqual({});
  });

  it("returns an empty config when the fetch throws", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(getSlackSettings(makeEnv(fetch))).resolves.toEqual({});
  });
});
