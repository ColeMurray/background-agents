import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared/service-auth";
import { ControlPlaneRequestError, fetchControlPlaneJson } from "./control-plane";
import { createFakeKV, makeLinearBotEnv } from "./test-helpers";

describe("fetchControlPlaneJson", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([undefined, "user-1"])(
    "signs the channel and optional actor: %s",
    async (actorUserId) => {
      const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ repos: [] })
      );
      const { kv } = createFakeKV();
      const env = makeLinearBotEnv(kv, { CONTROL_PLANE: { fetch } });

      await expect(
        fetchControlPlaneJson(
          env,
          "/repos?refresh=true",
          { linearTeamId: "external-team-1", actorUserId },
          "trace-1"
        )
      ).resolves.toEqual({ repos: [] });

      const [input, init] = fetch.mock.calls[0];
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.searchParams.get("channel")).toBe("linear:external-team-1");
      expect(url.searchParams.get("refresh")).toBe("true");
      expect(headers.get("X-OpenInspect-Actor")).toBe(actorUserId ? `linear:${actorUserId}` : null);
      expect(headers.get("x-trace-id")).toBe("trace-1");
      const verification = {
        signatureHeader: headers.get("X-OpenInspect-Service-Signature")!,
        service: "linear-bot" as const,
        secret: env.SERVICE_AUTH_SECRET!,
        method: "GET",
        url: url.toString(),
        bodySha256Hex: await sha256Hex(""),
        actor: headers.get("X-OpenInspect-Actor") ?? "",
      };
      expect(await verifyServiceSignature(verification)).toMatchObject({ ok: true });
      url.searchParams.set("channel", "linear:other-team");
      expect(await verifyServiceSignature({ ...verification, url: url.toString() })).toMatchObject({
        ok: false,
        reason: "mismatch",
      });
      if (actorUserId) {
        expect(
          await verifyServiceSignature({ ...verification, actor: "linear:other-user" })
        ).toMatchObject({ ok: false, reason: "mismatch" });
      }
    }
  );

  it.each([403, 404, 503])("throws on scoped HTTP %s", async (status) => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, {
      CONTROL_PLANE: { fetch: vi.fn(async () => new Response(null, { status })) },
    });

    await expect(
      fetchControlPlaneJson(env, "/repos", { linearTeamId: "external-team-1" })
    ).rejects.toBeInstanceOf(ControlPlaneRequestError);
  });
});
