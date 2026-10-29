import { describe, expect, it, vi } from "vitest";
import { isJwtUnexpired } from "../../auth/jwt";
import { E2BRestClient } from "../e2b-rest-client";
import { E2BSandboxProvider } from "../providers/e2b-provider";
import { createEnv, mockClient, providerConfig } from "../providers/e2b-provider.test-helpers";
import {
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockIdGenerator,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockWebSocketManager,
  createTestConfig,
  createTestLifecycleManager,
  createUnmanagedShutdown,
} from "./test-helpers";

describe("E2B terminal lifecycle", () => {
  it.each([true, false])(
    "publishes and retains terminal credentials only when enabled: %s",
    async (terminalEnabled) => {
      const session = createMockSession({
        sandbox_settings: JSON.stringify({ terminalEnabled, terminalPort: 7000 }),
      });
      const sandbox = createMockSandbox({ status: "pending" });
      const storage = createMockStorage(session, sandbox);
      const broadcaster = createMockBroadcaster();
      const client = mockClient({
        createSandbox: vi.fn(async () => ({
          sandboxID: "e2b-id",
          templateID: "tmpl",
          envdAccessToken: "envd-token",
          domain: "dedicated.example",
        })),
        getSandbox: vi.fn(async () => ({
          sandboxID: "e2b-id",
          templateID: "tmpl",
          state: "paused",
          domain: "dedicated.example",
        })),
        getHostnameForPort: E2BRestClient.prototype.getHostnameForPort,
      });
      const manager = createTestLifecycleManager(
        new E2BSandboxProvider(client, providerConfig),
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(true),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

      await manager.spawnSandbox();

      const url = terminalEnabled ? "https://7000-e2b-id.dedicated.example" : null;
      const token = sandbox.ttyd_token;
      expect(sandbox.ttyd_url).toBe(url);
      if (terminalEnabled) {
        expect(isJwtUnexpired(token)).toBe(true);
        const [header, body, signature] = token!.split(".");
        expect(JSON.parse(Buffer.from(body, "base64url").toString())).toMatchObject({
          sub: session.session_name,
          sid: sandbox.modal_sandbox_id,
        });
        // The credential clients receive must authenticate against the key
        // delivered to the E2B proxy, which survives memory-preserving resume.
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(createEnv(client).SANDBOX_AUTH_TOKEN),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"]
        );
        expect(
          await crypto.subtle.verify(
            "HMAC",
            key,
            Buffer.from(signature, "base64url"),
            new TextEncoder().encode(`${header}.${body}`)
          )
        ).toBe(true);
        expect(storage.commitProviderAccess).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ ttyd: { url, token } }),
          undefined,
          expect.any(Boolean)
        );
      } else {
        expect(token).toBeNull();
        expect(storage.commitProviderAccess).not.toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ ttyd: expect.anything() }),
          undefined,
          expect.any(Boolean)
        );
      }
      expect(broadcaster.messages).toContainEqual({ type: "sandbox_access_changed" });

      // A stopped persistent sandbox keeps its credential while its public URL
      // is cleared. Resume must republish it using the same runtime signing key.
      sandbox.status = "stopped";
      sandbox.ttyd_url = null;
      broadcaster.messages.length = 0;
      await manager.spawnSandbox();

      expect(client.createSandbox).toHaveBeenCalledOnce();
      expect(client.connectSandbox).toHaveBeenCalledExactlyOnceWith("e2b-id", 1800);
      expect(client.startProcess).toHaveBeenCalledOnce();
      expect(storage.commitProviderAccess).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ ttyd: terminalEnabled ? { url, token } : null })
      );
      expect(sandbox.ttyd_url).toBe(url);
      expect(sandbox.ttyd_token).toBe(token);
      expect(broadcaster.messages).toContainEqual({ type: "sandbox_access_changed" });
    }
  );
});
