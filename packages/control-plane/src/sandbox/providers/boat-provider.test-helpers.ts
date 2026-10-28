import { expect, vi } from "vitest";
import type { BoatLifecycleTimings } from "../boat-lifecycle";
import { BoatSandboxProvider, type BoatProviderConfig } from "./boat-provider";
import type {
  BoatCreatedSandbox,
  BoatCreateSandboxParams,
  BoatSavedSnapshot,
  BoatRestClient,
  BoatSandbox,
} from "../boat-rest-client";

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

/** A route the way the mock Boat hosts it: a public port ungated, any other behind a token. */
function boatRoute(port: number, isPublic: boolean) {
  return {
    port,
    url: isPublic
      ? `https://sub-${port}.on.boat.dev`
      : `https://sub-${port}.on.boat.dev?_token=tok${port}`,
    isProtected: !isPublic,
    access: isPublic ? "public" : "private",
  };
}

/** What the mock create answers: the sandbox, and a route for each port it was asked to host. */
export function boatCreated(
  params: Pick<BoatCreateSandboxParams, "hostedPorts"> | undefined,
  overrides: Partial<BoatSandbox> = {}
): BoatCreatedSandbox {
  return {
    sandbox: boatSandbox({ state: "provisioning", ...overrides }),
    hostedPorts: (params?.hostedPorts ?? []).map((request) =>
      boatRoute(request.port, request.public)
    ),
  };
}

function boatSavedSnapshot(overrides: Partial<BoatSavedSnapshot> = {}): BoatSavedSnapshot {
  return {
    name: "oi-img-acme-repo-0123456789abcdef",
    status: "ready",
    sourceSandboxId: "bx_abcdefgh",
    type: "default",
    sizeBytes: 3_907_112_960,
    createdAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function mockClient(overrides: Partial<BoatRestClient> = {}): BoatRestClient {
  return {
    config: { apiUrl: "https://boat.dev/api/v1", apiKey: "secret" },
    createSandbox: vi.fn(async (params: BoatCreateSandboxParams) => boatCreated(params)),
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
    saveSavedSnapshot: vi.fn(async (sandboxId: string, name: string) =>
      boatSavedSnapshot({ name, status: "saving", sourceSandboxId: sandboxId })
    ),
    getSavedSnapshot: vi.fn(async (name: string) => boatSavedSnapshot({ name })),
    deleteSavedSnapshot: vi.fn(async () => {}),
    hostPort: vi.fn(async (_id: string, options: { port: number; public: boolean }) =>
      boatRoute(options.port, options.public)
    ),
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
export const fastTimings: BoatLifecycleTimings = {
  pollIntervalMs: 1,
  readyPollIntervalMs: 1,
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
