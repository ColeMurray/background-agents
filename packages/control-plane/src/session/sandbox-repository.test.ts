import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { encryptToken, generateEncryptionKey } from "../auth/crypto";
import { createLogger } from "../logger";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { SandboxRepository } from "./sandbox-repository";
import { initSchema } from "./schema";

const TEST_ENCRYPTION_KEY = generateEncryptionKey();
const log = createLogger("sandbox-repository-test", {}, "error");

describe("SandboxRepository completeProviderResume (SQLite)", () => {
  const generation = { sandboxId: "sb-1", createdAt: 2000 };
  const access = {
    providerObjectId: "provider-2",
    codeServer: { url: "https://code.test", password: "code-secret" },
    vnc: { url: "https://vnc.test", password: "vnc-secret" },
    ttyd: { url: "https://terminal.test", token: "terminal-token" },
    tunnelUrls: { "3000": "https://preview.test" },
  };

  function createSqliteRepository() {
    const db = new DatabaseSync(":memory:");
    const { sql } = createNodeSqlStorage(db);
    initSchema(sql);
    const repository = new SandboxRepository(sql, log, TEST_ENCRYPTION_KEY);
    repository.createSandbox({
      id: "row-1",
      status: "connecting",
      gitSyncStatus: "pending",
      createdAt: generation.createdAt,
    });
    const set = (assignments: string, ...params: unknown[]) =>
      sql.exec(`UPDATE sandbox SET ${assignments}`, ...params);
    set("modal_sandbox_id = 'sb-1', modal_object_id = 'pending', auth_token_hash = 'hash-1'");
    return { db, repository, set };
  }

  it.each([
    [
      "replaced generation and auth hash",
      "modal_sandbox_id = 'sb-2', created_at = 3000, auth_token_hash = 'successor-hash'",
      "pending",
      false,
    ],
    ["identity-only supersession", "modal_sandbox_id = 'sb-2'", "pending", false],
    ["timestamp-only supersession", "created_at = 3000", "pending", false],
    ["stopped generation", "status = 'stopped'", "pending", false],
    ["stale generation", "status = 'stale'", "pending", false],
    ["failed generation", "status = 'failed'", "pending", false],
    ["fenced generation", "fenced = 1", "pending", false],
    [
      "changed expected provider reference",
      "modal_object_id = 'another-pending'",
      "pending",
      false,
    ],
    ["matching generation and provider reference", "modal_object_id = 'pending'", "pending", true],
    [
      "ordinary resume with a changed provider reference",
      "modal_object_id = 'changed'",
      undefined,
      true,
    ],
  ] as const)(
    "rechecks guarded SQL after credential encryption: %s",
    async (_case, change, expectedProviderObjectId, shouldCommit) => {
      const { db, repository, set } = createSqliteRepository();
      const [successorCodePassword, successorVncPassword, successorTtydToken] = await Promise.all([
        encryptToken("successor-code-secret", TEST_ENCRYPTION_KEY),
        encryptToken("successor-vnc-secret", TEST_ENCRYPTION_KEY),
        encryptToken("successor-terminal-token", TEST_ENCRYPTION_KEY),
      ]);
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      let beginEncryption!: () => void;
      let releaseEncryption!: () => void;
      const encrypting = new Promise<void>((resolve) => (beginEncryption = resolve));
      const gate = new Promise<void>((resolve) => (releaseEncryption = resolve));
      const spy = vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
        const encrypted = await encrypt(...args);
        beginEncryption();
        await gate;
        return encrypted;
      });
      try {
        const completion = repository.completeProviderResume(
          generation,
          access,
          expectedProviderObjectId
        );
        await encrypting;
        set(change);
        // Publish successor artifacts while the old completion is still awaiting encryption.
        set(
          `code_server_url = ?, code_server_password = ?, vnc_url = ?, vnc_password = ?,
           ttyd_url = ?, ttyd_token = ?, tunnel_urls = ?`,
          "https://successor-code.test",
          successorCodePassword,
          "https://successor-vnc.test",
          successorVncPassword,
          "https://successor-terminal.test",
          successorTtydToken,
          JSON.stringify({ "3000": "https://successor-preview.test" })
        );
        const successor = repository.getSandbox();
        releaseEncryption();
        await expect(completion).resolves.toBe(shouldCommit);

        const row = repository.getSandbox();
        if (shouldCommit) {
          expect(row).toMatchObject({
            modal_object_id: access.providerObjectId,
            code_server_url: access.codeServer.url,
            vnc_url: access.vnc.url,
            ttyd_url: access.ttyd.url,
            tunnel_urls: JSON.stringify(access.tunnelUrls),
          });
          expect(row?.code_server_password).not.toBe(access.codeServer.password);
          expect(row?.vnc_password).not.toBe(access.vnc.password);
          expect(row?.ttyd_token).not.toBe(access.ttyd.token);
        } else {
          expect(row).toEqual(successor);
        }
        await expect(repository.getSandboxAccessSecret("codeServer")).resolves.toBe(
          shouldCommit ? access.codeServer.password : "successor-code-secret"
        );
        await expect(repository.getSandboxAccessSecret("vnc")).resolves.toBe(
          shouldCommit ? access.vnc.password : "successor-vnc-secret"
        );
        await expect(repository.getSandboxAccessSecret("ttyd")).resolves.toBe(
          shouldCommit ? access.ttyd.token : "successor-terminal-token"
        );
      } finally {
        releaseEncryption();
        spy.mockRestore();
        db.close();
      }
    }
  );
});
