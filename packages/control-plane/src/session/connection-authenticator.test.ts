import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import {
  SessionConnectionAuthenticator,
  type SessionConnectionAuthenticatorDeps,
} from "./connection-authenticator";
import type { SandboxRow } from "./types";

describe("SessionConnectionAuthenticator", () => {
  it("persists admission state before accepting a sandbox socket", async () => {
    const calls: string[] = [];
    const sandbox = {
      modal_sandbox_id: "sandbox-id",
      auth_token: "sandbox-token",
      auth_token_hash: null,
      status: "ready",
    } as SandboxRow;
    const deps = {
      wsManager: {
        createUpgradeSockets: vi.fn(() => ({ client: {} as WebSocket, server: {} as WebSocket })),
        acceptAndSetSandboxSocket: vi.fn(() => {
          calls.push("accept");
          throw new Error("accept failed");
        }),
      },
      sessionCoreRepository: { getSession: vi.fn(() => null) },
      sandboxRepository: {
        getSandbox: vi.fn(() => sandbox),
      },
      lifecycleManager: {
        recordStartupHeartbeat: vi.fn(async () => {
          calls.push("persist");
          return true;
        }),
      },
    } as unknown as SessionConnectionAuthenticatorDeps;
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    const authenticator = new SessionConnectionAuthenticator(deps);
    const request = new Request("https://example.test?type=sandbox", {
      headers: {
        Authorization: "Bearer sandbox-token",
        "X-Sandbox-ID": "sandbox-id",
      },
    });

    const response = await authenticator.handleWebSocketUpgrade(request, new URL(request.url), log);

    expect(response.status).toBe(500);
    expect(calls).toEqual(["persist", "accept"]);
  });
});
