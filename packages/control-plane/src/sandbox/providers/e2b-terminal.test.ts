import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TERMINAL_PORT, INTERNAL_TTYD_PORT } from "@open-inspect/shared/types/integrations";
import { E2BRestClient } from "../e2b-rest-client";
import { E2BSandboxProvider } from "./e2b-provider";
import {
  baseCreateConfig,
  createEnv,
  mockClient,
  providerConfig,
} from "./e2b-provider.test-helpers";

// Exercise the real hostname builder, including the provider-returned domain.
function terminalClient(domain?: string) {
  return mockClient({
    createSandbox: vi.fn(async () => ({
      sandboxID: "e2b-id",
      templateID: "tmpl",
      envdAccessToken: "envd-token",
      domain,
    })),
    getHostnameForPort: E2BRestClient.prototype.getHostnameForPort,
  });
}

describe("E2B web terminal", () => {
  describe.each([undefined, "prebuilt-template"])("create from %s", (prebuiltImageId) => {
    it.each([
      { terminalPort: undefined, domain: undefined },
      { terminalPort: 7000, domain: "dedicated.example" },
    ])("exposes the authenticated proxy for %j", async ({ terminalPort, domain }) => {
      const client = terminalClient(domain);
      const port = terminalPort ?? DEFAULT_TERMINAL_PORT;
      const result = await new E2BSandboxProvider(client, providerConfig).createSandbox({
        ...baseCreateConfig,
        prebuiltImageId,
        sandboxSettings: {
          terminalEnabled: true,
          terminalPort,
          tunnelPorts: [port, INTERNAL_TTYD_PORT, 3000],
        },
        userEnvVars: { TERMINAL_ENABLED: "false", TTYD_PROXY_PORT: "9999" },
      });

      expect(createEnv(client)).toMatchObject({
        TERMINAL_ENABLED: "true",
        TTYD_PROXY_PORT: String(port),
      });
      expect(result.ttydUrl).toBe(`https://${port}-e2b-id.${domain ?? "e2b.app"}`);
      expect(result.tunnelUrls).toEqual({
        "3000": `https://3000-e2b-id.${domain ?? "e2b.app"}`,
      });
      expect(client.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ templateID: prebuiltImageId ?? "tmpl" })
      );
    });

    it.each([undefined, false])(
      "does not enable or advertise a terminal when %s",
      async (terminalEnabled) => {
        const client = terminalClient();
        const result = await new E2BSandboxProvider(client, providerConfig).createSandbox({
          ...baseCreateConfig,
          prebuiltImageId,
          sandboxSettings: { terminalEnabled, tunnelPorts: [DEFAULT_TERMINAL_PORT] },
          userEnvVars: { TERMINAL_ENABLED: "true", TTYD_PROXY_PORT: "9999" },
        });

        expect(createEnv(client)).not.toHaveProperty("TERMINAL_ENABLED");
        expect(createEnv(client)).not.toHaveProperty("TTYD_PROXY_PORT");
        expect(result.ttydUrl).toBeUndefined();
        expect(result.tunnelUrls).toEqual({
          [DEFAULT_TERMINAL_PORT]: `https://${DEFAULT_TERMINAL_PORT}-e2b-id.e2b.app`,
        });
      }
    );
  });

  describe.each(["paused", "running"])("resume a %s sandbox", (state) => {
    it.each([
      { terminalPort: undefined, domain: undefined },
      { terminalPort: 7000, domain: "dedicated.example" },
    ])(
      "preserves terminal access without restarting processes for %j",
      async ({ terminalPort, domain }) => {
        const client = terminalClient(domain);
        vi.mocked(client.getSandbox).mockResolvedValue({
          sandboxID: "e2b-id",
          templateID: "tmpl",
          state,
          domain,
        });
        const port = terminalPort ?? DEFAULT_TERMINAL_PORT;
        const result = await new E2BSandboxProvider(client, providerConfig).resumeSandbox({
          providerObjectId: "e2b-id",
          sessionId: "sess-1",
          sandboxId: "sandbox-logical",
          sandboxSettings: {
            terminalEnabled: true,
            terminalPort,
            tunnelPorts: [port, INTERNAL_TTYD_PORT, 3000],
          },
        });

        expect(result.success).toBe(true);
        expect(result.ttydUrl).toBe(`https://${port}-e2b-id.${domain ?? "e2b.app"}`);
        expect(result.tunnelUrls).toEqual({
          "3000": `https://3000-e2b-id.${domain ?? "e2b.app"}`,
        });
        expect(client.startProcess).not.toHaveBeenCalled();
        if (state === "paused") {
          expect(client.connectSandbox).toHaveBeenCalledExactlyOnceWith("e2b-id", 1800);
          expect(client.setSandboxTimeout).not.toHaveBeenCalled();
        } else {
          expect(client.setSandboxTimeout).toHaveBeenCalledExactlyOnceWith("e2b-id", 1800);
          expect(client.connectSandbox).not.toHaveBeenCalled();
        }
      }
    );

    it("keeps a same-numbered user tunnel generic when terminal access is disabled", async () => {
      const client = terminalClient();
      vi.mocked(client.getSandbox).mockResolvedValue({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state,
      });
      const result = await new E2BSandboxProvider(client, providerConfig).resumeSandbox({
        providerObjectId: "e2b-id",
        sessionId: "sess-1",
        sandboxId: "sandbox-logical",
        sandboxSettings: { terminalEnabled: false, tunnelPorts: [DEFAULT_TERMINAL_PORT] },
      });

      expect(result.success).toBe(true);
      expect(result.ttydUrl).toBeUndefined();
      expect(result.tunnelUrls).toEqual({
        [DEFAULT_TERMINAL_PORT]: `https://${DEFAULT_TERMINAL_PORT}-e2b-id.e2b.app`,
      });
      expect(client.startProcess).not.toHaveBeenCalled();
    });
  });
});
