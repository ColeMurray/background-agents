import { describe, expect, it, vi } from "vitest";
import {
  DurableObjectSessionConnections,
  type DurableObjectSessionConnectionSockets,
} from "./durable-object-session-connections";
import type { SandboxDeliveryUnavailableError } from "../session/connections";

function harness() {
  const browser = { readyState: WebSocket.OPEN } as WebSocket;
  const sandbox = { readyState: WebSocket.OPEN } as WebSocket;
  const manager: DurableObjectSessionConnectionSockets = {
    forEachClientSocket: vi.fn(
      (_mode: "all_clients" | "authenticated_only", fn: (ws: WebSocket) => void) => fn(browser)
    ),
    getSandboxSocket: vi.fn(() => sandbox),
    send: vi.fn(() => true),
    configureAutoPing: vi.fn(),
    createUpgradeSockets: vi.fn(),
  };
  return {
    connections: new DurableObjectSessionConnections(manager),
    manager,
    browser,
    sandbox,
  };
}

describe("DurableObjectSessionConnections", () => {
  it("owns Cloudflare auto-response configuration", () => {
    const { manager } = harness();

    expect(manager.configureAutoPing).toHaveBeenCalledTimes(1);
  });

  it("broadcasts to authenticated browser sockets", async () => {
    const { connections, manager, browser } = harness();
    const message = { type: "sandbox_status", status: "ready" } as const;

    await connections.broadcastToBrowsers(message);

    expect(manager.forEachClientSocket).toHaveBeenCalledWith(
      "authenticated_only",
      expect.any(Function)
    );
    expect(manager.send).toHaveBeenCalledWith(browser, message);
  });

  it("sends typed commands to the active sandbox", async () => {
    const { connections, manager, sandbox } = harness();

    await connections.sendToSandbox({ type: "snapshot" });

    expect(manager.send).toHaveBeenCalledWith(sandbox, { type: "snapshot" });
  });

  it("distinguishes missing sockets from failed delivery", async () => {
    const { connections, manager } = harness();
    vi.mocked(manager.getSandboxSocket).mockReturnValueOnce(null);

    await expect(connections.sendToSandbox({ type: "snapshot" })).rejects.toMatchObject({
      reason: "not_connected",
    } satisfies Partial<SandboxDeliveryUnavailableError>);

    vi.mocked(manager.send).mockReturnValueOnce(false);
    await expect(connections.sendToSandbox({ type: "snapshot" })).rejects.toMatchObject({
      reason: "send_failed",
    } satisfies Partial<SandboxDeliveryUnavailableError>);
  });
});
