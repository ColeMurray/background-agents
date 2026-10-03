import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared/service-auth";
import type { Env } from "../types";
import { getLinearConfig } from "./integration-config";

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

  it("rejects scoped reads with missing signing credentials or an invalid repository", async () => {
    const fetch = vi.fn();
    const env = { CONTROL_PLANE: { fetch } } as unknown as Env;
    const scope = { linearTeamId: "external-team-1" };

    await expect(getLinearConfig(env, "acme/backend", scope)).rejects.toThrow();
    await expect(
      getLinearConfig({ ...env, SERVICE_AUTH_SECRET: "test-secret" }, "invalid", scope)
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect((await getLinearConfig(env, "acme/backend")).model).toBeNull();
  });
});
