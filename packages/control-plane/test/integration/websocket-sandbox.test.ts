import { describe, it, expect } from "vitest";
import { initNamedSession, openSandboxWs, seedSandboxAuth, queryDO } from "./helpers";

const SANDBOX_TOKEN = "test-sandbox-auth-token-abc123";
const SANDBOX_ID = "sb-integration-test";
const DEFAULT_WAIT_FOR_SANDBOX_STATUS_TIMEOUT_MS = 3000;

async function waitForSandboxStatus(
  stub: DurableObjectStub,
  status: string,
  timeoutMs = DEFAULT_WAIT_FOR_SANDBOX_STATUS_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    const rows = await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox");
    lastStatus = rows[0]?.status;
    if (lastStatus === status) return;
    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for sandbox status "${status}"; last status was "${lastStatus ?? "missing"}"`
  );
}

describe("Sandbox WebSocket (via SELF.fetch)", () => {
  it("upgrade with valid auth returns 101", async () => {
    const name = `ws-sandbox-ok-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(101);
    expect(ws).not.toBeNull();
    ws!.accept();
    ws!.close();
  });

  it("upgrade with wrong token returns 401", async () => {
    const name = `ws-sandbox-badtoken-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: "wrong-token",
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(401);
    expect(ws).toBeNull();
  });

  it("upgrade with wrong sandbox ID returns 403", async () => {
    const name = `ws-sandbox-badid-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: "wrong-sandbox-id",
    });

    expect(response.status).toBe(403);
    expect(ws).toBeNull();
  });

  it("upgrade for stopped sandbox returns 410", async () => {
    const name = `ws-sandbox-stopped-${Date.now()}`;
    const { stub } = await initNamedSession(name);

    // Wait for init's fire-and-forget warmSandbox to fail (no Modal in test env)
    // before forcing stopped, otherwise it can race and overwrite the status.
    await waitForSandboxStatus(stub, "failed");

    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });
    await queryDO(stub, "UPDATE sandbox SET status = ?", "stopped");

    const { ws, response } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });

    expect(response.status).toBe(410);
    expect(ws).toBeNull();
  });

  it("sandbox connect sets status to ready", async () => {
    const name = `ws-sandbox-ready-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    // Wait for init's fire-and-forget warmSandbox to fail (no Modal in test env).
    // The spawn failure sets status to "failed" which we need to happen before
    // the WS connect sets it to "ready", otherwise the two race.
    await waitForSandboxStatus(stub, "failed");

    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    await waitForSandboxStatus(stub, "ready");

    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ sandbox: { status: string } }>();
    expect(state.sandbox.status).toBe("ready");

    ws!.close();
  });

  it("sandbox WS message is stored as event", async () => {
    const name = `ws-sandbox-event-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: SANDBOX_TOKEN, sandboxId: SANDBOX_ID });

    const { ws } = await openSandboxWs(name, {
      authToken: SANDBOX_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();

    // Send a token event via the sandbox WebSocket
    ws!.send(
      JSON.stringify({
        type: "tool_call",
        tool: "read_file",
        args: { path: "/src/main.ts" },
        callId: "call-ws-1",
        messageId: "msg-ws-1",
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
      })
    );

    // Allow time for the DO to process the message
    await new Promise((r) => setTimeout(r, 200));

    const events = await queryDO<{ type: string; data: string }>(
      stub,
      "SELECT type, data FROM events WHERE type = ?",
      "tool_call"
    );

    const matching = events.filter((e) => {
      const data = JSON.parse(e.data);
      return data.callId === "call-ws-1";
    });
    expect(matching.length).toBeGreaterThanOrEqual(1);

    ws!.close();
  });
});
