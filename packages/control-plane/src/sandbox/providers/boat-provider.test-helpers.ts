import { expect, vi } from "vitest";
import {
  BoatSandboxProvider,
  type BoatProviderConfig,
  type BoatProviderTimings,
} from "./boat-provider";
import type { BoatRestClient, BoatSandbox } from "../boat-rest-client";

export const providerConfig: BoatProviderConfig = {
  scmProvider: "github",
  sandboxAccessPasswordSecret: "secret",
  baseSnapshot: "open-inspect-abc123",
  defaultMachineType: "default",
  deploymentName: "test",
};

export function boatSandbox(overrides: Partial<BoatSandbox> = {}): BoatSandbox {
  return {
    id: "bx_abcdefgh",
    state: "ready",
    type: "default",
    archiveAfter: "2030-01-02T03:04:05.000Z",
    ttlSeconds: 7200,
    snapshotAvailable: false,
    hydrated: true,
    stop: null,
    ...overrides,
  };
}

export function mockClient(overrides: Partial<BoatRestClient> = {}): BoatRestClient {
  return {
    config: { apiUrl: "https://boat.dev/api/v1", apiKey: "secret" },
    createSandbox: vi.fn(async () => boatSandbox({ state: "provisioning" })),
    getSandbox: vi.fn(async () => boatSandbox()),
    updateSandbox: vi.fn(async () => boatSandbox()),
    stopSandbox: vi.fn(async () => boatSandbox({ state: "archiving" })),
    resumeSandbox: vi.fn(async () => {}),
    unshareSandbox: vi.fn(async () => boatSandbox({ visibility: "private" })),
    deleteSandbox: vi.fn(async () => {}),
    startDetachedCommand: vi.fn(async () => ({ processId: 4242 })),
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false })),
    getCommandStatus: vi.fn(async () => ({
      status: "running" as const,
      running: true,
      exitCode: null,
      stdout: "",
      stderr: "",
    })),
    writeFile: vi.fn(async () => {}),
    hostPort: vi.fn(async (_id: string, options: { port: number; public: boolean }) => ({
      port: options.port,
      url: options.public
        ? `https://sub-${options.port}.on.boat.dev`
        : `https://sub-${options.port}.on.boat.dev?_token=tok${options.port}`,
      isProtected: !options.public,
      access: options.public ? "public" : "private",
    })),
    ...overrides,
  } as unknown as BoatRestClient;
}

/** The env delivered on the first create call. */
export function createEnv(client: BoatRestClient): Record<string, string> {
  const [params] = vi.mocked(client.createSandbox).mock.calls[0];
  expect(params.env).toBeDefined();
  return params.env;
}

export const baseCreateConfig = {
  sessionId: "sess-1",
  sandboxId: "sandbox-logical",
  repoOwner: "o",
  repoName: "r",
  controlPlaneUrl: "https://cp.test",
  sandboxAuthToken: "tok",
  harness: "opencode" as const,
  provider: "anthropic",
  model: "claude",
  codeServerEnabled: true,
};

/** Polling intervals shrunk so the provider's waits complete within a unit test. */
export const fastTimings: BoatProviderTimings = {
  pollIntervalMs: 1,
  readyTimeoutMs: 200,
  stopTimeoutMs: 200,
  launchSettleMs: 5,
  launchPollIntervalMs: 1,
  createRetryDelayMs: 1,
};

export function createProvider(
  client: BoatRestClient,
  config: BoatProviderConfig = providerConfig
): BoatSandboxProvider {
  return new BoatSandboxProvider(client, config, fastTimings);
}
