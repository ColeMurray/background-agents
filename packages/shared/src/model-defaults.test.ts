import { describe, expect, it, vi } from "vitest";
import { fetchModelDefaults } from "./model-defaults";
import { DEFAULT_MODEL, DEFAULT_PLAN_MODEL } from "./models";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchModelDefaults", () => {
  it("returns control-plane values when the fetch succeeds with both fields", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        enabledModels: ["anthropic/claude-haiku-4-5"],
        defaultModel: "anthropic/claude-haiku-4-5",
        defaultPlanModel: "anthropic/claude-opus-4-6",
      })
    );

    const result = await fetchModelDefaults({
      CONTROL_PLANE: { fetch: fetcher } as never,
      INTERNAL_CALLBACK_SECRET: "secret",
      DEFAULT_MODEL: "claude-sonnet-4-5", // ignored, CP wins
    });

    expect(result).toEqual({
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultPlanModel: "anthropic/claude-opus-4-6",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://internal/model-preferences",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("falls back to env when the CP response is non-OK", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));

    const result = await fetchModelDefaults({
      CONTROL_PLANE: { fetch: fetcher } as never,
      DEFAULT_MODEL: "claude-haiku-4-5",
      DEFAULT_PLAN_MODEL: "claude-opus-4-6",
    });

    expect(result).toEqual({
      defaultModel: "claude-haiku-4-5",
      defaultPlanModel: "claude-opus-4-6",
    });
  });

  it("falls back to env when the CP response is malformed", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ enabledModels: ["x"] }) // missing defaults
    );

    const result = await fetchModelDefaults({
      CONTROL_PLANE: { fetch: fetcher } as never,
      DEFAULT_MODEL: "claude-haiku-4-5",
    });

    expect(result.defaultModel).toBe("claude-haiku-4-5");
    expect(result.defaultPlanModel).toBe(DEFAULT_PLAN_MODEL);
  });

  it("falls back to env-or-shared when the fetch throws", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("service binding gone"));

    const result = await fetchModelDefaults({
      CONTROL_PLANE: { fetch: fetcher } as never,
      DEFAULT_MODEL: "claude-haiku-4-5",
    });

    expect(result.defaultModel).toBe("claude-haiku-4-5");
    expect(result.defaultPlanModel).toBe(DEFAULT_PLAN_MODEL);
  });

  it("falls back to shared constants when env vars are also missing", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));

    const result = await fetchModelDefaults({
      CONTROL_PLANE: { fetch: fetcher } as never,
    });

    expect(result).toEqual({
      defaultModel: DEFAULT_MODEL,
      defaultPlanModel: DEFAULT_PLAN_MODEL,
    });
  });
});
