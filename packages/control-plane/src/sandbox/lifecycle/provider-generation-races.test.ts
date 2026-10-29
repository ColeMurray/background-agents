import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { generateEncryptionKey } from "../../auth/crypto";
import { createLogger } from "../../logger";
import { createNodeSqlStorage } from "../../node/sqlite-storage";
import { SandboxRepository } from "../../session/sandbox-repository";
import { initSchema } from "../../session/schema";
import type { CreateSandboxResult } from "../provider";
import {
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockIdGenerator,
  createMockProvider,
  createMockStorage,
  createMockWebSocketManager,
  createTestConfig,
  createTestLifecycleManager,
  createUnmanagedShutdown,
  noLifetime,
} from "./test-helpers";

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(kind: "spawn" | "restore" = "spawn") {
  const db = new DatabaseSync(":memory:");
  const { sql } = createNodeSqlStorage(db);
  initSchema(sql);
  const storage = new SandboxRepository(
    sql,
    createLogger("generation-test"),
    generateEncryptionKey()
  );
  storage.createSandbox({ id: "row", status: "pending", gitSyncStatus: "pending", createdAt: 1 });
  if (kind === "restore") {
    storage.updateSandboxStatus("stopped");
    sql.exec(
      "UPDATE sandbox SET snapshot_image_id = ?, snapshot_runtime_version = ?",
      "saved-image",
      COMPATIBLE_RUNTIME_VERSION
    );
  }
  const broadcaster = createMockBroadcaster();
  const sockets = createMockWebSocketManager(false);
  const shutdown = createUnmanagedShutdown();
  const created = gate<CreateSandboxResult>();
  const launch = vi.fn(() => created.promise);
  const provider = createMockProvider({
    createSandbox: launch,
    restoreFromSnapshot: async () => ({ ...(await launch()), success: true as const }),
  });
  const manager = createTestLifecycleManager(
    provider,
    storage,
    createMockStorage(),
    broadcaster,
    sockets,
    createMockAlarmScheduler(),
    createMockIdGenerator(),
    shutdown,
    createTestConfig()
  );
  const result = (): CreateSandboxResult => ({
    sandboxId: storage.getSandbox()!.modal_sandbox_id!,
    providerObjectId: "provider-A",
    createdAt: Date.now(),
    lifetime: noLifetime(),
    codeServerUrl: "https://code-A.test",
    codeServerPassword: "code-A-secret",
    vncAccess: { url: "https://vnc-A.test", password: "vnc-A-secret" },
    tunnelUrls: { "3000": "https://preview-A.test" },
    ttydUrl: "https://terminal-A.test",
  });
  const replace = (sameId = false) => {
    const row = storage.getSandbox()!;
    storage.updateSandboxForSpawn({
      status: "spawning",
      createdAt: row.created_at + 1,
      modalSandboxId: sameId ? row.modal_sandbox_id! : "sandbox-B",
    });
    sql.exec(`UPDATE sandbox SET modal_object_id = 'provider-B',
      code_server_url = 'https://code-B.test', code_server_password = 'encrypted-code-B',
      vnc_url = 'https://vnc-B.test', vnc_password = 'encrypted-vnc-B',
      ttyd_url = 'https://terminal-B.test', ttyd_token = 'encrypted-terminal-B',
      tunnel_urls = '{"3000":"https://preview-B.test"}'`);
  };
  return {
    db,
    provider,
    storage,
    broadcaster,
    sockets,
    shutdown,
    created,
    launch,
    manager,
    result,
    replace,
  };
}

describe("provider generation races (real SQLite and encryption)", () => {
  afterEach(() => vi.restoreAllMocks());

  describe.each(["spawn", "restore"] as const)("%s", (kind) => {
    it.each(["codeServer", "vnc", "ttyd", "tunnelUrls"] as const)(
      "preserves bridge-reconciled access when foreground returns only %s",
      async (field) => {
        const f = fixture(kind);
        const spawning = f.manager.spawnSandbox();
        try {
          await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
          const row = f.storage.getSandbox()!;
          const generation = { sandboxId: row.modal_sandbox_id, createdAt: row.created_at };
          f.manager.onSandboxSocketAttached(generation);
          // VM reconciliation uses this same generation-scoped repository commit.
          await expect(
            f.storage.commitProviderAccess(generation, {
              providerObjectId: "provider-A",
              codeServer: { url: "https://bridge-code.test", password: "bridge-code-secret" },
              vnc: { url: "https://bridge-vnc.test", password: "bridge-vnc-secret" },
              ttyd: { url: "https://bridge-terminal.test", token: "bridge-terminal-token" },
              tunnelUrls: { "8080": "https://bridge-preview.test" },
            })
          ).resolves.toBe(true);
          const bridge = f.storage.getSandbox()!;
          const full = f.result();
          const partial: CreateSandboxResult = {
            sandboxId: full.sandboxId,
            providerObjectId: full.providerObjectId,
            createdAt: full.createdAt,
            lifetime: full.lifetime,
            ...(field === "codeServer"
              ? { codeServerUrl: full.codeServerUrl, codeServerPassword: full.codeServerPassword }
              : {}),
            ...(field === "vnc" ? { vncAccess: full.vncAccess } : {}),
            ...(field === "ttyd" ? { ttydUrl: full.ttydUrl } : {}),
            ...(field === "tunnelUrls" ? { tunnelUrls: full.tunnelUrls } : {}),
          };
          f.created.resolve(partial);
          await spawning;
          const current = f.storage.getSandbox()!;
          const columns = {
            codeServer: ["code_server_url", "code_server_password"],
            vnc: ["vnc_url", "vnc_password"],
            ttyd: ["ttyd_url", "ttyd_token"],
            tunnelUrls: ["tunnel_urls"],
          } as const;
          for (const [kind, names] of Object.entries(columns)) {
            for (const column of names) {
              if (kind === field) expect(current[column]).not.toEqual(bridge[column]);
              else expect(current[column]).toEqual(bridge[column]);
            }
          }
          await expect(f.storage.getSandboxAccessSecret("codeServer")).resolves.toBe(
            field === "codeServer" ? full.codeServerPassword : "bridge-code-secret"
          );
          await expect(f.storage.getSandboxAccessSecret("vnc")).resolves.toBe(
            field === "vnc" ? full.vncAccess!.password : "bridge-vnc-secret"
          );
        } finally {
          f.created.resolve(f.result());
          await spawning;
          f.db.close();
        }
      }
    );

    it.each([false, true])(
      "does not publish old access after replacement during encryption (same id=%s)",
      async (sameId) => {
        const f = fixture(kind);
        const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
        const encrypting = gate<void>();
        const release = gate<void>();
        vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
          const encrypted = await encrypt(...args);
          encrypting.resolve();
          await release.promise;
          return encrypted;
        });
        const spawning = f.manager.spawnSandbox();
        try {
          await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
          f.created.resolve(f.result());
          await encrypting.promise;
          f.replace(sameId);
          const replacement = f.storage.getSandbox();
          const publications = [...f.broadcaster.messages];
          release.resolve();
          await spawning;
          expect(f.storage.getSandbox()).toEqual(replacement);
          expect(f.broadcaster.messages).toEqual(publications);
        } finally {
          release.resolve();
          await spawning;
          f.db.close();
        }
      }
    );

    it("does not publish old terminal access after replacement during signing", async () => {
      const f = fixture(kind);
      const sign = crypto.subtle.sign.bind(crypto.subtle);
      const signing = gate<void>();
      const release = gate<void>();
      vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
        const signature = await sign(...args);
        signing.resolve();
        await release.promise;
        return signature;
      });
      const spawning = f.manager.spawnSandbox();
      try {
        await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
        f.created.resolve(f.result());
        await signing.promise;
        f.replace();
        const replacement = f.storage.getSandbox();
        const publications = [...f.broadcaster.messages];
        release.resolve();
        await spawning;
        expect(f.storage.getSandbox()).toEqual(replacement);
        expect(f.broadcaster.messages).toEqual(publications);
      } finally {
        release.resolve();
        await spawning;
        f.db.close();
      }
    });

    it("does not announce old startup after replacement during lifetime recording", async () => {
      const f = fixture(kind);
      const recording = gate<void>();
      const release = gate<void>();
      f.shutdown.recordProviderStartup.mockImplementationOnce(async () => {
        recording.resolve();
        await release.promise;
      });
      const spawning = f.manager.spawnSandbox();
      try {
        await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
        f.created.resolve(f.result());
        await recording.promise;
        f.replace();
        const replacement = f.storage.getSandbox();
        const publications = [...f.broadcaster.messages];
        release.resolve();
        await spawning;
        expect(f.storage.getSandbox()).toEqual(replacement);
        expect(f.broadcaster.messages).toEqual(publications);
      } finally {
        release.resolve();
        await spawning;
        f.db.close();
      }
    });

    it("commits current access together and encrypts every secret", async () => {
      const f = fixture(kind);
      const spawning = f.manager.spawnSandbox();
      try {
        await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce());
        const result = f.result();
        f.created.resolve(result);
        await spawning;
        const row = f.storage.getSandbox()!;
        expect(row).toMatchObject({
          modal_object_id: result.providerObjectId,
          status: "connecting",
          code_server_url: result.codeServerUrl,
          vnc_url: result.vncAccess!.url,
          ttyd_url: result.ttydUrl,
          tunnel_urls: JSON.stringify(result.tunnelUrls),
        });
        expect(row.code_server_password).not.toBe(result.codeServerPassword);
        expect(row.vnc_password).not.toBe(result.vncAccess!.password);
        await expect(f.storage.getSandboxAccessSecret("codeServer")).resolves.toBe(
          result.codeServerPassword
        );
        await expect(f.storage.getSandboxAccessSecret("vnc")).resolves.toBe(
          result.vncAccess!.password
        );
        const token = (await f.storage.getSandboxAccessSecret("ttyd"))!;
        expect(token.split(".")).toHaveLength(3);
        expect(row.ttyd_token).not.toBe(token);
      } finally {
        f.created.resolve(f.result());
        await spawning;
        f.db.close();
      }
    });

    it("keeps B pending while it retires A before reserving its generation", async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(10_000_000);
      const f = fixture(kind);
      const stopping = gate<void>();
      const releaseStop = gate<void>();
      const second = gate<CreateSandboxResult>();
      f.launch
        .mockImplementationOnce(() => f.created.promise)
        .mockImplementationOnce(() => second.promise);
      const spawningA = f.manager.spawnSandbox();
      let spawningB: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(f.launch).toHaveBeenCalledTimes(1));
        const resultA = f.result();
        f.manager.onSandboxConnected();
        f.storage.updateSandboxStatus("stale");
        f.storage.updateSandboxModalObjectId("pending-A");
        f.storage.fenceSandboxGeneration();
        f.provider.capabilities.supportsExplicitStop = true;
        f.provider.stopSandbox = vi.fn(async (config) => {
          if (config.reason === "respawn") {
            stopping.resolve();
            await releaseStop.promise;
          }
          return { success: true };
        });
        clock.mockReturnValue(10_031_000);
        spawningB = f.manager.spawnSandbox();
        await stopping.promise;
        f.created.resolve(resultA);
        await spawningA;
        expect(f.manager.isSpawning()).toBe(true);
        expect(f.manager.isProviderStartupPending()).toBe(true);
        releaseStop.resolve();
        await vi.waitFor(() => expect(f.launch).toHaveBeenCalledTimes(2));
        second.resolve(f.result());
        await spawningB;
      } finally {
        releaseStop.resolve();
        f.created.resolve(f.result());
        second.resolve(f.result());
        await spawningA;
        await spawningB;
        f.db.close();
      }
    });

    it.each(["success", "failure"] as const)(
      "keeps B's startup flags when A has a late %s",
      async (outcome) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(10_000_000);
        const f = fixture(kind);
        const second = gate<CreateSandboxResult>();
        f.launch
          .mockImplementationOnce(() => f.created.promise)
          .mockImplementationOnce(() => second.promise);
        const spawningA = f.manager.spawnSandbox();
        let spawningB: Promise<void> | undefined;
        try {
          await vi.waitFor(() => expect(f.launch).toHaveBeenCalledTimes(1));
          const resultA = f.result();
          // Early attach releases A's launch guard; a stale heartbeat permits B.
          f.manager.onSandboxConnected();
          f.storage.updateSandboxStatus("stale");
          clock.mockReturnValue(10_031_000);
          spawningB = f.manager.spawnSandbox();
          await vi.waitFor(() => expect(f.launch).toHaveBeenCalledTimes(2));
          const replacement = f.storage.getSandbox();
          if (outcome === "success") f.created.resolve(resultA);
          else f.created.reject(new Error("A failed late"));
          await spawningA;
          expect(f.manager.isSpawning()).toBe(true);
          expect(f.manager.isProviderStartupPending()).toBe(true);
          expect(f.storage.getSandbox()).toEqual(replacement);
          second.resolve(f.result());
          await spawningB;
          expect(f.manager.isSpawning()).toBe(false);
          expect(f.manager.isProviderStartupPending()).toBe(false);
        } finally {
          f.created.resolve(f.result());
          second.resolve(f.result());
          await spawningA;
          await spawningB;
          f.db.close();
        }
      }
    );
  });
});
