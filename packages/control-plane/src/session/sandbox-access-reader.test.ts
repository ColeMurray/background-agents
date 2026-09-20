import { describe, expect, it, vi } from "vitest";
import { encryptToken, generateEncryptionKey } from "../auth/crypto";
import { SessionAccessReader } from "./sandbox-access-reader";
import type { Logger } from "../logger";
import type { SandboxRepository } from "./sandbox-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SandboxRow } from "./types";

const ENCRYPTION_KEY = generateEncryptionKey();

function createSandbox(): SandboxRow {
  return {
    id: "sandbox-1",
    status: "ready",
    modal_object_id: "provider-sandbox-1",
    code_server_url: null,
    code_server_password: null,
    vnc_url: null,
    vnc_password: null,
    tunnel_urls: null,
    ttyd_url: "https://terminal.test/expired",
    ttyd_token: null,
  } as SandboxRow;
}

function createReader(sandbox: SandboxRow, refreshTtydAccess: () => Promise<boolean>) {
  return new SessionAccessReader({
    sessionCoreRepository: { getSession: vi.fn(() => ({})) } as unknown as SessionCoreRepository,
    sandboxRepository: { getSandbox: vi.fn(() => sandbox) } as unknown as SandboxRepository,
    repoSecretsEncryptionKey: ENCRYPTION_KEY,
    sandboxDashboardSettings: {
      sandboxProvider: "daytona",
      modalWorkspace: undefined,
      modalEnvironment: undefined,
    },
    refreshTtydAccess,
    log: { warn: vi.fn() } as unknown as Logger,
  });
}

describe("SessionAccessReader", () => {
  it("refreshes the terminal URL before returning access", async () => {
    const sandbox = createSandbox();
    sandbox.ttyd_token = await encryptToken("terminal-token", ENCRYPTION_KEY);
    const refreshTtydAccess = vi.fn(async () => {
      sandbox.ttyd_url = "https://terminal.test/refreshed";
      return true;
    });

    const response = await createReader(sandbox, refreshTtydAccess).handleSandboxAccess();
    const body = (await response.json()) as { ttyd: { url: string; token: string } | null };

    expect(refreshTtydAccess).toHaveBeenCalledOnce();
    expect(body.ttyd).toEqual({ url: "https://terminal.test/refreshed", token: "terminal-token" });
  });

  it("does not return a stale terminal URL when refresh fails", async () => {
    const sandbox = createSandbox();
    sandbox.ttyd_token = await encryptToken("terminal-token", ENCRYPTION_KEY);

    const response = await createReader(sandbox, async () => false).handleSandboxAccess();
    const body = (await response.json()) as { ttyd: unknown };

    expect(body.ttyd).toBeNull();
  });
});
