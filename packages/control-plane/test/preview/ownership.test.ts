import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startPreviewStack } from "./stack";
import { startFakeModalServer } from "../smoke/fake-modal-server.mjs";
import { generateInternalToken } from "@open-inspect/shared/auth";

describe("preview ownership", () => {
  it("does not replace another coordinator's lock or Next lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "oi-preview-lock-"));
    try {
      await mkdir(join(root, ".preview"));
      const lock = join(root, ".preview/lock.json");
      await writeFile(lock, "other owner");
      await expect(startPreviewStack({ root })).rejects.toThrow("checkout already owned");
      expect(await readFile(lock, "utf8")).toBe("other owner");
      await rm(lock);
      await mkdir(join(root, "packages/web/.next/dev"), { recursive: true });
      await writeFile(join(root, "packages/web/.next/dev/lock"), "next owner");
      await expect(startPreviewStack({ root })).rejects.toThrow("Next lock exists");
      await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "packages/web/.next/dev/lock"), "utf8")).toBe("next owner");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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
});
