import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
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

  it.each(["held", "timed"])("cancels a %s turn and keeps the bridge reusable", async (mode) => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("No WebSocket server address");
    const events: SandboxEvent[] = [];
    const connection = new Promise<WebSocket>((resolve) => {
      server.on("connection", (socket) => {
        socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
        resolve(socket);
      });
    });
    const chunkDelayMs = 1000;
    const fake = await startFakeModalServer({ secret: "fixture-secret", chunkDelayMs });
    try {
      if (mode === "held") fake.holdTurns();
      const response = await fetch(`${fake.origin}/api-create-sandbox`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await generateInternalToken("fixture-secret")}` },
        body: JSON.stringify({
          session_id: "session-1",
          sandbox_id: "sandbox-1",
          control_plane_url: `http://127.0.0.1:${address.port}`,
          sandbox_auth_token: "token",
        }),
      });
      expect(response.status).toBe(200);
      const socket = await connection;
      socket.send(JSON.stringify({ type: "prompt", messageId: "stopped", content: "Stop me" }));
      await vi.waitFor(() => expect(events.some((event) => event.type === "token")).toBe(true));
      socket.send(JSON.stringify({ type: "stop" }));
      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === "execution_complete")).toEqual([
          expect.objectContaining({
            messageId: "stopped",
            success: false,
            error: "Task was cancelled",
          }),
        ])
      );
      socket.send(JSON.stringify({ type: "stop" }));
      fake.releaseTurns();
      // Exercise both release and the original timer deadline after cancellation.
      await new Promise((resolve) => setTimeout(resolve, chunkDelayMs * 2));
      expect(
        events.filter((event) => "messageId" in event && event.messageId === "stopped")
      ).toHaveLength(2);
      expect(fake.activeBridges).toBe(1);
      socket.send(JSON.stringify({ type: "prompt", messageId: "next", content: "Continue" }));
      await vi.waitFor(
        () =>
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "execution_complete",
              messageId: "next",
              success: true,
            })
          ),
        { timeout: 3000 }
      );
      expect(fake.state.errors).toEqual([]);
    } finally {
      await fake.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("validates snapshot sandbox identity before recording a snapshot", async () => {
    const fake = await startFakeModalServer({ secret: "fixture-secret" });
    try {
      const headers = { Authorization: `Bearer ${await generateInternalToken("fixture-secret")}` };
      for (const sandbox_id of [undefined, null, "", 123]) {
        const response = await fetch(`${fake.origin}/api-snapshot-sandbox`, {
          method: "POST",
          headers,
          body: JSON.stringify({ sandbox_id }),
        });
        expect(response.status).toBe(500);
      }
      expect(fake.state.snapshots).toBe(0);
      expect(fake.state.errors).toEqual(
        Array(4).fill("/api-snapshot-sandbox: request carried no sandbox_id")
      );
      const response = await fetch(`${fake.origin}/api-snapshot-sandbox`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sandbox_id: "mo-sandbox-1" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, data: { image_id: "smoke-image-1" } });
      expect(fake.state.snapshots).toBe(1);
    } finally {
      await fake.close();
    }
  });
});
