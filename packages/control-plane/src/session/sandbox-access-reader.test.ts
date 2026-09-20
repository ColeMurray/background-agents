import { describe, expect, it, vi } from "vitest";
import { SessionAccessReader } from "./sandbox-access-reader";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SandboxRow } from "./types";
import { createLogger } from "../logger";
import { encryptToken, generateEncryptionKey } from "../auth/crypto";

const encryptionKey = generateEncryptionKey();

async function harness() {
  const row = {
    id: "sb-row",
    modal_sandbox_id: "attempt",
    created_at: 1,
    status: "ready",
    modal_object_id: "provider-object",
    code_server_url: "https://code.test",
    code_server_password: await encryptToken("code-secret", encryptionKey),
    vnc_url: null,
    vnc_password: null,
    ttyd_url: null,
    ttyd_token: null,
    tunnel_urls: null,
  } as SandboxRow;
  const getSandbox = vi.fn<() => SandboxRow | null>(() => row);
  const getSession = vi.fn(() => ({ id: "session" }));
  const reader = new SessionAccessReader({
    sandboxRepository: { getSandbox },
    sessionCoreRepository: { getSession } as unknown as SessionCoreRepository,
    // Exercise real encryption and the async decrypt seam without a crypto mock.
    repoSecretsEncryptionKey: encryptionKey,
    sandboxDashboardSettings: {
      sandboxProvider: "e2b",
      modalWorkspace: undefined,
      modalEnvironment: undefined,
    },
    log: createLogger("sandbox-access-test"),
  });
  return { row, getSandbox, reader };
}

describe("SessionAccessReader lifecycle eligibility", () => {
  it("serves ready access with private no-store headers", async () => {
    const h = await harness();
    const response = await h.reader.handleSandboxAccess();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      codeServer: { url: "https://code.test", password: "code-secret" },
    });
  });

  it.each([
    "pending",
    "spawning",
    "connecting",
    "warming",
    "snapshotting",
    "stopped",
    "stale",
    "failed",
  ] as const)(
    "keeps access unavailable while %s, even when ordinary dispatch policy differs",
    async (status) => {
      const h = await harness();
      h.row.status = status;
      expect((await h.reader.handleSandboxAccess()).status).toBe(409);
      expect(h.getSandbox).toHaveBeenCalledOnce();
    }
  );

  it("rejects a missing row", async () => {
    const h = await harness();
    h.getSandbox.mockReturnValue(null);
    expect((await h.reader.handleSandboxAccess()).status).toBe(409);
  });

  it.each([
    ["status", "snapshotting"],
    ["status", "stopped"],
    ["id", "replacement"],
    ["modal_object_id", "replacement-object"],
    ["code_server_url", "https://new.test"],
    ["code_server_password", "new-secret"],
    ["vnc_url", "https://vnc.test"],
    ["vnc_password", "new-vnc"],
    ["ttyd_url", "https://tty.test"],
    ["ttyd_token", "new-tty"],
    ["tunnel_urls", "{}"],
  ] as const)("rejects changed %s after decryption", async (field, value) => {
    const h = await harness();
    const response = h.reader.handleSandboxAccess();
    h.getSandbox.mockReturnValue({ ...h.row, [field]: value });
    const result = await response;
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: "Sandbox access changed; retry" });
  });
});
