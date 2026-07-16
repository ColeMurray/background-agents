import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { getLinearConfig } from "./integration-config";

describe("getLinearConfig", () => {
  function envForResponse(body: unknown): Env {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    return {
      INTERNAL_CALLBACK_SECRET: "test-secret",
      CONTROL_PLANE: { fetch },
    } as unknown as Env;
  }

  it("encodes nested repository owners as one route segment", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ config: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const env = {
      INTERNAL_CALLBACK_SECRET: "test-secret",
      CONTROL_PLANE: { fetch },
    } as unknown as Env;

    await getLinearConfig(env, "group/subgroup/web");

    expect(fetch).toHaveBeenCalledWith(
      "https://internal/integration-settings/linear/resolved/group%2Fsubgroup/web",
      expect.any(Object)
    );
  });

  it("returns a parsed resolved config", async () => {
    await expect(
      getLinearConfig(
        envForResponse({
          config: {
            model: "openai/gpt-5.4",
            reasoningEffort: null,
            allowUserPreferenceOverride: false,
            allowLabelModelOverride: true,
            emitToolProgressActivities: false,
            issueSessionInstructions: "Use small commits.",
            enabledRepos: ["acme/backend"],
          },
        }),
        "acme/backend"
      )
    ).resolves.toEqual({
      model: "openai/gpt-5.4",
      reasoningEffort: null,
      allowUserPreferenceOverride: false,
      allowLabelModelOverride: true,
      emitToolProgressActivities: false,
      issueSessionInstructions: "Use small commits.",
      enabledRepos: ["acme/backend"],
    });
  });

  it("falls back when the response shape is malformed", async () => {
    await expect(
      getLinearConfig(
        envForResponse({
          config: {
            model: "openai/gpt-5.4",
            allowUserPreferenceOverride: "yes",
          },
        }),
        "acme/backend"
      )
    ).resolves.toEqual({
      model: null,
      reasoningEffort: null,
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: true,
      emitToolProgressActivities: true,
      issueSessionInstructions: null,
      enabledRepos: null,
    });
  });
});
