import { expect, vi } from "vitest";
import type { E2BProviderConfig } from "./e2b-provider";
import type { E2BRestClient, E2BSandboxDetail } from "../e2b-rest-client";

export const providerConfig: E2BProviderConfig = {
  scmProvider: "github",
  sandboxAccessPasswordSecret: "secret",
  sandboxTimeoutSeconds: 1800,
  autoPause: true,
};

export function mockClient(overrides: Partial<E2BRestClient> = {}): E2BRestClient {
  return {
    config: { apiUrl: "https://api.e2b.app", apiKey: "secret", templateId: "tmpl" },
    createSandbox: vi.fn(async () => ({
      sandboxID: "e2b-id",
      templateID: "tmpl",
      envdAccessToken: "envd-token",
    })),
    getSandbox: vi.fn(
      async (): Promise<E2BSandboxDetail> => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state: "paused",
      })
    ),
    pauseSandbox: vi.fn(async () => {}),
    connectSandbox: vi.fn(async () => ({
      sandboxID: "e2b-id",
      templateID: "tmpl",
      envdAccessToken: "fresh-envd-token",
    })),
    startProcess: vi.fn(async () => {}),
    killSandbox: vi.fn(async () => {}),
    setSandboxTimeout: vi.fn(async () => {}),
    createSnapshot: vi.fn(async () => ({ snapshotID: "snap-abc:default", names: ["oi/snap"] })),
    deleteTemplate: vi.fn(async () => {}),
    getHostnameForPort: vi.fn((id: string, port: number) => `https://${port}-${id}.e2b.app`),
    ...overrides,
  } as unknown as E2BRestClient;
}

export function createEnv(client: E2BRestClient): Record<string, string> {
  const [params] = vi.mocked(client.createSandbox).mock.calls[0];
  expect(params.envVars).toBeDefined();
  return params.envVars!;
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
