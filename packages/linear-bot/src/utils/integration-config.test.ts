import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { Logger } from "../logger";
import { checkHarnessCompatibility } from "@open-inspect/shared/harnesses";
import { getLinearConfig, resolveLinearSessionHarness } from "./integration-config";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

describe("getLinearConfig", () => {
  function envForFetchResponse(response: Response): Env {
    const fetch = vi.fn().mockResolvedValue(response);
    return {
      SERVICE_AUTH_SECRET: "test-secret",
      CONTROL_PLANE: { fetch },
    } as unknown as Env;
  }

  function envForResponse(body: unknown): Env {
    return envForFetchResponse(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  }

  it("encodes nested repository owners as one route segment", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ config: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const env = {
      SERVICE_AUTH_SECRET: "test-secret",
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
      harness: null,
      reasoningEffort: null,
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: true,
      emitToolProgressActivities: true,
      issueSessionInstructions: null,
      enabledRepos: null,
    });
  });

  it("falls back when the response is invalid JSON", async () => {
    await expect(
      getLinearConfig(
        envForFetchResponse(
          new Response("{not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        ),
        "acme/backend"
      )
    ).resolves.toEqual({
      model: null,
      harness: null,
      reasoningEffort: null,
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: true,
      emitToolProgressActivities: true,
      issueSessionInstructions: null,
      enabledRepos: null,
    });
  });

  it("parses the harness from a successful response", async () => {
    await expect(
      getLinearConfig(
        envForResponse({
          config: {
            model: "anthropic/claude-opus-4-6",
            harness: "claude",
            reasoningEffort: null,
            allowUserPreferenceOverride: true,
            allowLabelModelOverride: true,
            emitToolProgressActivities: true,
            issueSessionInstructions: null,
            enabledRepos: null,
          },
        }),
        "acme/backend"
      )
    ).resolves.toMatchObject({ harness: "claude" });
  });

  it("treats a response without a harness key as unset (older control plane)", async () => {
    const config = await getLinearConfig(
      envForResponse({
        config: {
          model: "anthropic/claude-opus-4-6",
          reasoningEffort: null,
          allowUserPreferenceOverride: true,
          allowLabelModelOverride: true,
          emitToolProgressActivities: true,
          issueSessionInstructions: null,
          enabledRepos: null,
        },
      }),
      "acme/backend"
    );

    expect(config.harness).toBeUndefined();
    expect(resolveLinearSessionHarness(config.harness, "anthropic/claude-opus-4-6")).toBeNull();
  });
});

describe("resolveLinearSessionHarness", () => {
  it("returns null when unset, so the field is omitted", () => {
    expect(resolveLinearSessionHarness(null, "openai/gpt-5.4")).toBeNull();
    expect(resolveLinearSessionHarness(undefined, "openai/gpt-5.4")).toBeNull();
  });

  it("keeps a compatible configured harness", () => {
    expect(resolveLinearSessionHarness("claude", "anthropic/claude-opus-4-6")).toBe("claude");
  });

  it("omits with a warning on a cross-level mismatch", () => {
    const log = createMockLogger();
    expect(resolveLinearSessionHarness("claude", "openai/gpt-5.4", log)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "config.harness_model_mismatch",
      expect.objectContaining({ harness: "claude", model: "openai/gpt-5.4", fallback: "opencode" })
    );
    // Lock the user-facing reason: gpt-5.4 is a catalog model the harness
    // cannot run, so this test exercises the compatibility check itself.
    expect(checkHarnessCompatibility("claude", "openai/gpt-5.4")?.message).toContain(
      'Model "openai/gpt-5.4" cannot run on the Claude Agent harness.'
    );
  });

  it("keeps the harness when a stale model canonicalizes to a compatible one", () => {
    // openai/gpt-5 is absent from the catalog, so session creation resolves it
    // to the default model (Claude Sonnet). The check must judge that
    // canonical model — not the raw string — or it would drop a harness the
    // created session would have honored.
    expect(resolveLinearSessionHarness("claude", "openai/gpt-5")).toBe("claude");
  });
});
