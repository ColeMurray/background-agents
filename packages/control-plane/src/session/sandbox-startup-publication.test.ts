import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { generateEncryptionKey, decryptToken } from "../auth/crypto";
import { createLogger } from "../logger";
import { SandboxRepository } from "./sandbox-repository";
import { SCHEMA_SQL } from "./schema";
import type { SandboxStartupPublication } from "../sandbox/lifecycle/manager";

describe("provider startup publication", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function fixture() {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec(SCHEMA_SQL);
    const key = generateEncryptionKey();
    const repository = new SandboxRepository(
      createNodeSqlStorage(db).sql,
      createLogger("test"),
      key
    );
    repository.createSandbox({
      id: "row",
      status: "pending",
      gitSyncStatus: "pending",
      createdAt: 1,
    });
    const generation = { sandboxId: "attempt-A", createdAt: 100 };
    repository.updateSandboxForSpawn({
      status: "spawning",
      createdAt: generation.createdAt,
      modalSandboxId: generation.sandboxId,
    });
    const data: SandboxStartupPublication = {
      providerObjectId: "provider-A",
      executionExpiry: { kind: "hard", expiresAtMs: 9999 },
      access: {
        codeServer: { url: "https://code-A", secret: "code-secret-A" },
        vnc: { url: "https://vnc-A", secret: "vnc-secret-A" },
        ttyd: { url: "https://tty-A", secret: "terminal-secret-A" },
      },
      tunnelUrls: { "3000": "https://port-A" },
    };
    return { repository, key, generation, data };
  }

  it("publishes expiry, provider identity, and encrypted access together", async () => {
    const { repository, key, generation, data } = fixture();
    expect(await repository.publishSandboxStartup(generation, data)).toBe(true);
    const row = repository.getSandbox()!;
    expect(row).toMatchObject({
      modal_object_id: "provider-A",
      provider_execution_expiry_kind: "hard",
      provider_execution_expires_at_ms: 9999,
      code_server_url: "https://code-A",
      vnc_url: "https://vnc-A",
      ttyd_url: "https://tty-A",
    });
    expect(await decryptToken(row.code_server_password!, key)).toBe("code-secret-A");
    expect(await decryptToken(row.vnc_password!, key)).toBe("vnc-secret-A");
    expect(await decryptToken(row.ttyd_token!, key)).toBe("terminal-secret-A");
    expect(JSON.stringify(row)).not.toContain("secret-A");
    expect(
      await repository.publishSandboxStartup(generation, { ...data, providerObjectId: "duplicate" })
    ).toBe(false);
  });

  it("rejects a replaced generation after asynchronous secret preparation begins", async () => {
    const { repository, generation, data } = fixture();
    const publication = repository.publishSandboxStartup(generation, data);
    repository.updateSandboxForSpawn({
      status: "spawning",
      createdAt: 200,
      modalSandboxId: "attempt-B",
    });
    expect(await publication).toBe(false);
    expect(repository.getSandbox()).toMatchObject({
      modal_sandbox_id: "attempt-B",
      modal_object_id: null,
      provider_execution_expiry_kind: null,
      code_server_url: null,
      vnc_url: null,
      ttyd_url: null,
      tunnel_urls: null,
    });
    expect(repository.closeSandboxStartup(generation)).toBe(false);
  });

  it.each(["failed", "stopped", "stale"] as const)(
    "rejects publication after the current attempt becomes %s",
    async (status) => {
      const { repository, generation, data } = fixture();
      const publication = repository.publishSandboxStartup(generation, data);
      repository.updateSandboxStatus(status);
      expect(await publication).toBe(false);
      expect(repository.getSandbox()).toMatchObject({
        status,
        modal_object_id: null,
        provider_execution_expiry_kind: null,
      });
    }
  );

  it("closes an early-ready failed attempt to unknown without changing readiness", () => {
    const { repository, generation } = fixture();
    repository.updateSandboxStatus("ready");
    expect(repository.closeSandboxStartup(generation)).toBe(true);
    expect(repository.getSandbox()).toMatchObject({
      status: "ready",
      provider_execution_expiry_kind: "unknown",
      provider_execution_expires_at_ms: null,
    });
    expect(repository.closeSandboxStartup(generation)).toBe(false);
  });
});
