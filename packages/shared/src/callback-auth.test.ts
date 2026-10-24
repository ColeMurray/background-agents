import { describe, expect, it } from "vitest";
import { computeHmacHex } from "./auth";
import { getCallbackAuthRejection } from "./callback-auth";

const env = { SERVICE_AUTH_SECRET: "secret" };
async function sign(payload: Record<string, unknown>) {
  return {
    ...payload,
    signature: await computeHmacHex(JSON.stringify(payload), env.SERVICE_AUTH_SECRET),
  };
}

describe("framework-neutral callback authentication", () => {
  it.each([undefined, ""])(
    "distinguishes a missing secret (%j) from a bad signature",
    async (secret) => {
      expect(await getCallbackAuthRejection(null, { SERVICE_AUTH_SECRET: secret })).toEqual({
        status: 500,
        error: "not configured",
        reason: "secret_not_configured",
      });
    }
  );

  it.each([null, undefined, [], {}, "invalid", { signature: 1 }, { signature: "bad" }])(
    "rejects unsigned or forged payloads: %j",
    async (payload) => {
      expect(await getCallbackAuthRejection(payload, env)).toEqual({
        status: 401,
        error: "unauthorized",
        reason: "invalid_signature",
      });
    }
  );

  it("verifies the original object including unknown fields and whitespace", async () => {
    const payload = await sign({
      sessionId: " session-1 ",
      context: { channel: "C1", unknown: "signed too" },
      extra: true,
    });
    expect(await getCallbackAuthRejection(payload, env)).toBeNull();
    expect(
      (await getCallbackAuthRejection({ ...payload, sessionId: "session-1" }, env))?.status
    ).toBe(401);
    const { extra: _extra, ...stripped } = payload;
    expect((await getCallbackAuthRejection(stripped, env))?.status).toBe(401);
  });

  it("does not add payload parsing policy to the authentication contract", async () => {
    expect(await getCallbackAuthRejection(await sign({ notACallback: true }), env)).toBeNull();
  });

  it("refuses a payload signed for another service secret", async () => {
    expect(
      (
        await getCallbackAuthRejection(await sign({ sessionId: "s1" }), {
          SERVICE_AUTH_SECRET: "other",
        })
      )?.status
    ).toBe(401);
  });
});
