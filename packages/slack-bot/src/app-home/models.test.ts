import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { getAuthoritativeModels, getAvailableModels } from "./models";

describe("getAvailableModels", () => {
  it("normalizes valid legacy IDs and filters removed models", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ enabledModels: ["openai/gpt-5.2", "gpt-5.4"] }))
      );
    const env = {
      SERVICE_AUTH_SECRET: "test-secret",
      CONTROL_PLANE: { fetch },
    } as unknown as Env;

    const models = await getAvailableModels(env);

    expect(models.map((model) => model.value)).toEqual(["openai/gpt-5.4"]);
  });

  it("falls back to defaults for malformed model-preference responses", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabledModels: "all" })));
    const env = {
      SERVICE_AUTH_SECRET: "test-secret",
      CONTROL_PLANE: { fetch },
    } as unknown as Env;

    const models = await getAvailableModels(env);

    expect(models.length).toBeGreaterThan(0);
    expect(models.map((model) => model.value)).not.toEqual(["all"]);
  });
});

describe("getAuthoritativeModels", () => {
  it("returns canonical enabled models without presentation fallback", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ enabledModels: ["gpt-5.4", "unknown/model"] }))
      );
    const env = {
      SERVICE_AUTH_SECRET: "test-secret",
      CONTROL_PLANE: { fetch },
    } as unknown as Env;

    await expect(getAuthoritativeModels(env)).resolves.toEqual(["openai/gpt-5.4"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://internal/model-preferences?strict=true",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("returns null when authoritative preferences are unavailable", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const env = {
      SERVICE_AUTH_SECRET: "test-secret",
      CONTROL_PLANE: { fetch },
    } as unknown as Env;

    await expect(getAuthoritativeModels(env)).resolves.toBeNull();
  });
});
