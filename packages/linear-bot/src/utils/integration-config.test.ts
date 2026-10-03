import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared/service-auth";
import { checkHarnessCompatibility } from "@open-inspect/shared/harnesses";
import type { Env } from "../types";
import type { Logger } from "../logger";
import { getLinearConfig, resolveLinearSessionHarness } from "./integration-config";

describe("getLinearConfig", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([undefined, "user-1"])(
    "signs a scoped config read and optional actor: %s",
    async (actorUserId) => {
      const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ config: null })
      );
      const env = {
        SERVICE_AUTH_SECRET: "test-secret",
        CONTROL_PLANE: { fetch },
      } as unknown as Env;

      const config = await getLinearConfig(env, "group/subgroup/web", {
        linearTeamId: "external-team-1",
        actorUserId,
      });

      expect(config.model).toBeNull();
      const [input, init] = fetch.mock.calls[0];
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.pathname).toBe("/integration-settings/linear/resolved/group%2Fsubgroup/web");
      expect(url.searchParams.get("channel")).toBe("linear:external-team-1");
      expect(headers.get("X-OpenInspect-Actor")).toBe(actorUserId ? `linear:${actorUserId}` : null);
      expect(
        await verifyServiceSignature({
          signatureHeader: headers.get("X-OpenInspect-Service-Signature")!,
          service: "linear-bot",
          secret: env.SERVICE_AUTH_SECRET!,
          method: "GET",
          url: url.toString(),
          bodySha256Hex: await sha256Hex(""),
          actor: headers.get("X-OpenInspect-Actor") ?? "",
        })
      ).toMatchObject({ ok: true });
    }
  );

  it.each(["denied", "not-found", "unavailable", "network", "malformed", "invalid-json"])(
    "throws on a scoped %s config read instead of using defaults",
    async (failure) => {
      const fetch = vi.fn(async () => {
        if (failure === "network") throw new Error("Control plane unavailable");
        if (failure === "invalid-json") return new Response("{not-json");
        if (failure === "malformed") return Response.json({ config: { model: "openai/gpt-5.4" } });
        return new Response(null, {
          status: failure === "denied" ? 403 : failure === "not-found" ? 404 : 503,
        });
      });
      const env = {
        SERVICE_AUTH_SECRET: "test-secret",
        CONTROL_PLANE: { fetch },
      } as unknown as Env;

      await expect(
        getLinearConfig(env, "acme/backend", { linearTeamId: "external-team-1" })
      ).rejects.toThrow();
    }
  );

  it("rejects reads with missing signing credentials or an invalid repository", async () => {
    const fetch = vi.fn();
    const env = { CONTROL_PLANE: { fetch } } as unknown as Env;
    const scope = { linearTeamId: "external-team-1" };

    await expect(getLinearConfig(env, "acme/backend", scope)).rejects.toThrow();
    await expect(
      getLinearConfig({ ...env, SERVICE_AUTH_SECRET: "test-secret" }, "invalid", scope)
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("parses the harness from a successful response", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
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
      })
    );
    const env = {
      SERVICE_AUTH_SECRET: "test-secret",
      CONTROL_PLANE: { fetch },
    } as unknown as Env;

    const config = await getLinearConfig(env, "acme/backend", { linearTeamId: "external-team-1" });

    expect(config.harness).toBe("claude");
  });

  it("treats a response without a harness key as unset (older control plane)", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        config: {
          model: "anthropic/claude-opus-4-6",
          reasoningEffort: null,
          allowUserPreferenceOverride: true,
          allowLabelModelOverride: true,
          emitToolProgressActivities: true,
          issueSessionInstructions: null,
          enabledRepos: null,
        },
      })
    );
    const env = {
      SERVICE_AUTH_SECRET: "test-secret",
      CONTROL_PLANE: { fetch },
    } as unknown as Env;

    const config = await getLinearConfig(env, "acme/backend", { linearTeamId: "external-team-1" });

    expect(config.harness).toBeUndefined();
    expect(resolveLinearSessionHarness(config.harness, "anthropic/claude-opus-4-6")).toBeNull();
  });
});

describe("resolveLinearSessionHarness", () => {
  function createMockLogger(): Logger {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as Logger;
  }

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
