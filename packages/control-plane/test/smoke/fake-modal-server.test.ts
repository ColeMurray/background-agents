import { describe, expect, it } from "vitest";
import { generateInternalToken } from "@open-inspect/shared/auth";
import { startFakeModalServer } from "./fake-modal-server.mjs";

describe("fake Modal peer", () => {
  it("validates sandbox HMAC, records unsupported HTTP operations, and closes its port", async () => {
    const fake = await startFakeModalServer({ secret: "fixture-secret" });
    try {
      expect(
        (await fetch(`${fake.origin}/api-stop-sandbox`, { method: "POST", body: "{}" })).status
      ).toBe(401);
      expect(fake.state.rejectedTokens).toBe(1);
      expect(
        (await fetch(`${fake.origin}/unsupported`, { method: "POST", body: "{}" })).status
      ).toBe(404);
      expect(fake.state.unexpectedRequests).toEqual(["POST /unsupported"]);
      const token = await generateInternalToken("fixture-secret");
      expect(
        (
          await fetch(`${fake.origin}/api-stop-sandbox`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: JSON.stringify({ sandbox_id: "gone" }),
          })
        ).status
      ).toBe(200);
    } finally {
      await fake.close();
    }
    expect(fake.activeBridges).toBe(0);
    await expect(fetch(fake.origin)).rejects.toThrow();
  });

  it("fails and records a sandbox request that lacks a field it acts on", async () => {
    const fake = await startFakeModalServer({ secret: "fixture-secret" });
    try {
      const response = await fetch(`${fake.origin}/api-restore-sandbox`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await generateInternalToken("fixture-secret")}` },
        // The session sits in `session_config` on restore; a root `session_id` is create's shape.
        body: JSON.stringify({
          sandbox_id: "sandbox-1",
          session_id: "session-1",
          control_plane_url: "http://127.0.0.1:1",
          sandbox_auth_token: "token",
        }),
      });
      expect(response.status).toBe(500);
      expect(fake.state.errors).toEqual([
        "/api-restore-sandbox: request carried no session_config.session_id",
      ]);
      expect(fake.activeBridges).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it("holds and releases turns over its HTTP control surface", async () => {
    const fake = await startFakeModalServer({ secret: "fixture-secret" });
    try {
      for (const action of ["hold", "release"]) {
        const response = await fetch(`${fake.origin}/__smoke/${action}`, { method: "POST" });
        expect(response.status).toBe(204);
      }
      expect((await fetch(`${fake.origin}/__smoke/hold`)).status).toBe(404);
      expect(fake.state.unexpectedRequests).toEqual(["GET /__smoke/hold"]);
    } finally {
      await fake.close();
    }
  });
});
