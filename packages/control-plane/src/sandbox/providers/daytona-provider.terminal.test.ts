import { DEFAULT_TERMINAL_PORT } from "@open-inspect/shared/types/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateSandboxConfig, ResumeConfig } from "../provider";
import {
  DaytonaApiError,
  type DaytonaCreateSandboxParams,
  type DaytonaRestClient,
  type DaytonaSandboxResponse,
  type DaytonaSignedPreviewUrlResponse,
} from "../daytona-rest-client";
import {
  DaytonaSandboxProvider,
  DEFAULT_PREVIEW_EXPIRY_SECONDS,
  type DaytonaProviderConfig,
} from "./daytona-provider";

const providerConfig: DaytonaProviderConfig = {
  scmProvider: "github",
  sandboxAccessPasswordSecret: "test-secret-key",
};

const createConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token-abc",
  harness: "opencode",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

const resumeConfig: ResumeConfig = {
  providerObjectId: "daytona-sandbox-id",
  sessionId: "session-123",
  sandboxId: "sandbox-456",
};

function createClient(
  overrides: Partial<{
    createSandbox: (params: DaytonaCreateSandboxParams) => Promise<DaytonaSandboxResponse>;
    getSignedPreviewUrl: (
      id: string,
      port: number,
      expiry: number
    ) => Promise<DaytonaSignedPreviewUrlResponse>;
  }> = {}
): DaytonaRestClient {
  return {
    config: {
      apiUrl: "https://daytona.test/api",
      apiKey: "test-api-key",
      baseSnapshot: "base-snapshot-v1",
      autoStopIntervalMinutes: 120,
      autoArchiveIntervalMinutes: 10080,
    },
    requireBaseSnapshot: vi.fn(() => "base-snapshot-v1"),
    createSandbox: vi.fn(async () => ({ id: "daytona-sandbox-id", state: "started" })),
    getSandbox: vi.fn(async () => ({ id: "daytona-sandbox-id", state: "started" })),
    startSandbox: vi.fn(async () => {}),
    getSignedPreviewUrl: vi.fn(async (_id, port) => ({
      url: `https://preview.test/${port}`,
    })),
    ...overrides,
  } as unknown as DaytonaRestClient;
}

describe("DaytonaSandboxProvider web terminal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects the default proxy port, returns its URL, and excludes it from tunnels", async () => {
    const client = createClient();
    const result = await new DaytonaSandboxProvider(client, providerConfig).createSandbox({
      ...createConfig,
      sandboxSettings: {
        terminalEnabled: true,
        tunnelPorts: [DEFAULT_TERMINAL_PORT, 3000, 3000],
      },
    });
    const envVars = vi.mocked(client.createSandbox).mock.calls[0][0].env!;

    expect(envVars).toMatchObject({
      TERMINAL_ENABLED: "true",
      TTYD_PROXY_PORT: String(DEFAULT_TERMINAL_PORT),
    });
    expect(result.ttydUrl).toBe(`https://preview.test/${DEFAULT_TERMINAL_PORT}`);
    expect(result.tunnelUrls).toEqual({ "3000": "https://preview.test/3000" });
    expect(client.getSignedPreviewUrl).toHaveBeenNthCalledWith(
      1,
      "daytona-sandbox-id",
      DEFAULT_TERMINAL_PORT,
      DEFAULT_PREVIEW_EXPIRY_SECONDS
    );
    expect(client.getSignedPreviewUrl).toHaveBeenNthCalledWith(
      2,
      "daytona-sandbox-id",
      3000,
      DEFAULT_PREVIEW_EXPIRY_SECONDS
    );
  });

  it("uses a custom terminal proxy port", async () => {
    const client = createClient();
    const result = await new DaytonaSandboxProvider(client, providerConfig).createSandbox({
      ...createConfig,
      sandboxSettings: { terminalEnabled: true, terminalPort: 7000 },
    });
    const envVars = vi.mocked(client.createSandbox).mock.calls[0][0].env!;

    expect(envVars.TTYD_PROXY_PORT).toBe("7000");
    expect(result.ttydUrl).toBe("https://preview.test/7000");
    expect(client.getSignedPreviewUrl).toHaveBeenCalledWith(
      "daytona-sandbox-id",
      7000,
      DEFAULT_PREVIEW_EXPIRY_SECONDS
    );
  });

  it("does not start or expose the terminal when disabled", async () => {
    const client = createClient();
    const result = await new DaytonaSandboxProvider(client, providerConfig).createSandbox({
      ...createConfig,
      userEnvVars: { TERMINAL_ENABLED: "true", TTYD_PROXY_PORT: "7000" },
      sandboxSettings: { terminalEnabled: false },
    });
    const envVars = vi.mocked(client.createSandbox).mock.calls[0][0].env!;

    expect(envVars.TERMINAL_ENABLED).toBe("");
    expect(envVars.TTYD_PROXY_PORT).toBeUndefined();
    expect(result.ttydUrl).toBeUndefined();
    expect(client.getSignedPreviewUrl).not.toHaveBeenCalled();
  });

  it("rejects a terminal port that collides with the default code-server port", async () => {
    const client = createClient();
    const provider = new DaytonaSandboxProvider(client, providerConfig);

    await expect(
      provider.createSandbox({
        ...createConfig,
        codeServerEnabled: true,
        sandboxSettings: { terminalEnabled: true, terminalPort: 8080 },
      })
    ).rejects.toMatchObject({
      errorType: "permanent",
    });
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it("keeps successful terminal and tunnel previews when code-server preview fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createClient({
      getSignedPreviewUrl: async (_id, port) => {
        if (port === 8080) throw new DaytonaApiError("preview unavailable", 500);
        return { url: `https://preview.test/${port}` };
      },
    });

    const result = await new DaytonaSandboxProvider(client, providerConfig).createSandbox({
      ...createConfig,
      codeServerEnabled: true,
      sandboxSettings: { terminalEnabled: true, tunnelPorts: [3000] },
    });

    expect(result.providerObjectId).toBe("daytona-sandbox-id");
    expect(result.codeServerUrl).toBeUndefined();
    expect(result.ttydUrl).toBe(`https://preview.test/${DEFAULT_TERMINAL_PORT}`);
    expect(result.tunnelUrls).toEqual({ "3000": "https://preview.test/3000" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("daytona.preview_url_failed"));
  });

  it("requests all enabled previews concurrently", async () => {
    const resolvers = new Map<number, (preview: DaytonaSignedPreviewUrlResponse) => void>();
    const client = createClient({
      getSignedPreviewUrl: vi.fn(
        (_id, port) =>
          new Promise<DaytonaSignedPreviewUrlResponse>((resolve) => {
            resolvers.set(port, resolve);
          })
      ),
    });
    const creation = new DaytonaSandboxProvider(client, providerConfig).createSandbox({
      ...createConfig,
      codeServerEnabled: true,
      sandboxSettings: { terminalEnabled: true, tunnelPorts: [3000] },
    });

    await vi.waitFor(() => expect(client.getSignedPreviewUrl).toHaveBeenCalledTimes(3));
    for (const [port, resolve] of resolvers) {
      resolve({ url: `https://preview.test/${port}` });
    }

    await expect(creation).resolves.toMatchObject({
      codeServerUrl: "https://preview.test/8080",
      ttydUrl: `https://preview.test/${DEFAULT_TERMINAL_PORT}`,
      tunnelUrls: { "3000": "https://preview.test/3000" },
    });
  });

  it("keeps successful generic tunnels when terminal preview creation fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createClient({
      getSignedPreviewUrl: async (_id, port) => {
        if (port === DEFAULT_TERMINAL_PORT) {
          throw new DaytonaApiError("preview unavailable", 500);
        }
        return { url: `https://preview.test/${port}` };
      },
    });

    const result = await new DaytonaSandboxProvider(client, providerConfig).createSandbox({
      ...createConfig,
      sandboxSettings: { terminalEnabled: true, tunnelPorts: [3000] },
    });

    expect(result.providerObjectId).toBe("daytona-sandbox-id");
    expect(result.ttydUrl).toBeUndefined();
    expect(result.tunnelUrls).toEqual({ "3000": "https://preview.test/3000" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("daytona.preview_url_failed"));
  });

  it("returns terminal access after resume using the custom proxy port", async () => {
    const client = createClient();
    const result = await new DaytonaSandboxProvider(client, providerConfig).resumeSandbox({
      ...resumeConfig,
      sandboxSettings: {
        terminalEnabled: true,
        terminalPort: 7002,
        tunnelPorts: [7002, 3000],
      },
    });

    expect(result.ttydUrl).toBe("https://preview.test/7002");
    expect(result.tunnelUrls).toEqual({ "3000": "https://preview.test/3000" });
    expect(client.getSignedPreviewUrl).toHaveBeenCalledWith(
      "daytona-sandbox-id",
      7002,
      DEFAULT_PREVIEW_EXPIRY_SECONDS
    );
  });
});
