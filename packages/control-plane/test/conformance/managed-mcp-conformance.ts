import { describe, it, expect } from "vitest";
import type { SqlDatabase } from "../../src/db/sql-database";
import { McpServerStore } from "../../src/db/mcp-servers";
import { McpConnectionStore, connectionBinding } from "../../src/db/mcp-connections";
import { McpOAuthService, MCP_REFRESH_STALE_MS } from "../../src/mcp/oauth";
import { ManagedMcpGatewayFixture } from "../fixtures/managed-mcp-gateway";
import { encryptToken, generateEncryptionKey } from "../../src/auth/crypto";
import { mergeUsers } from "../../src/db/user-merge";

type Factory = (run: (db: SqlDatabase) => Promise<void>) => Promise<void>;
export function managedMcpConformance(factory: Factory) {
  describe("managed MCP service credential compatibility", () => {
    it("accepts encrypted and legacy plaintext headers without including them in managed launch config", () =>
      factory(async (db) => {
        const registry = new McpServerStore(db, generateEncryptionKey());
        const headers = { Authorization: "Bearer test-service", "X-Test-Header": "test" };
        const server = await registry.create({
          name: "legacy-service",
          type: "remote",
          url: "https://mcp.fixture.test/mcp",
          enabled: true,
          headers,
        });
        expect(await registry.getServiceHeaders(server.id, server.authRevision!)).toEqual(headers);
        await db
          .prepare("UPDATE mcp_servers SET env = ? WHERE id = ?")
          .bind(` \n${JSON.stringify(headers)}`, server.id)
          .run();
        const managed = (await registry.update(server.id, { managedRouting: true }))!;
        expect(await registry.getServiceHeaders(server.id, managed.authRevision!)).toEqual(headers);
        await expect(registry.getServiceHeaders(server.id, server.authRevision!)).rejects.toThrow();
        expect((await registry.getForLaunch([]))[0].headers).toEqual({});
      }));

    it.each(["malformed-json", "invalid-map", "corrupt-ciphertext", "encrypted-invalid-map"])(
      "fails closed for %s service credentials",
      (format) =>
        factory(async (db) => {
          const key = generateEncryptionKey();
          const registry = new McpServerStore(db, key);
          const server = await registry.create({
            name: "invalid-service",
            type: "remote",
            url: "https://mcp.fixture.test/mcp",
            enabled: true,
            managedRouting: true,
            authMode: "service_credentials",
          });
          const invalidMap = JSON.stringify({ Authorization: "Bearer test-service", invalid: 42 });
          const raw =
            format === "malformed-json"
              ? "{broken"
              : format === "invalid-map"
                ? invalidMap
                : format === "corrupt-ciphertext"
                  ? await encryptToken("{}", generateEncryptionKey())
                  : await encryptToken(invalidMap, key);
          await db
            .prepare("UPDATE mcp_servers SET env = ? WHERE id = ?")
            .bind(raw, server.id)
            .run();
          await expect(
            registry.getServiceHeaders(server.id, server.authRevision!)
          ).rejects.toThrow();
        })
    );
  });
  async function fixture(db: SqlDatabase) {
    for (const id of ["alice", "bob"])
      await db
        .prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)")
        .bind(id, Date.now(), Date.now())
        .run();
    for (const id of ["alice", "bob"])
      await db
        .prepare(
          "INSERT INTO auth_sessions (id, userId, token, createdAt, updatedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(`browser-${id}`, id, `cookie-${id}`, Date.now(), Date.now(), Date.now() + 3600000)
        .run();
    const key = generateEncryptionKey();
    const gateway = new ManagedMcpGatewayFixture();
    const registry = new McpServerStore(db, key);
    const server = await registry.create({
      name: "example",
      type: "remote",
      url: `${gateway.origin}/mcp`,
      enabled: true,
      managedRouting: true,
      authMode: "user_oauth",
      oauth: { issuer: gateway.origin, resource: `${gateway.origin}/mcp` },
    });
    const store = new McpConnectionStore(db, key);
    const service = new McpOAuthService(store, (request) => gateway.fetch(request));
    async function authorize(owner = "alice", externalUser = "reader") {
      const url = new URL(
        await service.start(
          owner,
          `browser-${owner}`,
          server,
          "https://app.fixture.test/api/mcp-connections/oauth/callback"
        )
      );
      url.searchParams.set("fixture_user", externalUser);
      const response = await gateway.fetch(new Request(url));
      const callback = new URL(response.headers.get("Location")!);
      return {
        state: callback.searchParams.get("state")!,
        code: callback.searchParams.get("code")!,
        iss: callback.searchParams.get("iss")!,
      };
    }
    async function connect(owner = "alice", externalUser = "reader") {
      await service.callback(owner, `browser-${owner}`, await authorize(owner, externalUser));
      return connectionBinding((await store.get(owner, server.id))!);
    }
    async function expire(owner = "alice") {
      const row = (await store.get(owner, server.id))!;
      const credential = await store.decrypt(row);
      await store.claimRefresh(row, "test-expiry", Date.now());
      await store.publishRefresh(row, "test-expiry", { ...credential, expiresAt: Date.now() - 1 });
    }
    return {
      key,
      gateway,
      server,
      registry,
      store,
      service,
      authorize,
      connect,
      expire,
    };
  }
  describe("managed MCP real-storage OAuth and rotation", () => {
    it("keeps two owned grants isolated, encrypts storage, rejects wrong-owner and replayed callbacks", () =>
      factory(async (db) => {
        const f = await fixture(db);
        const callback = await f.authorize();
        await expect(f.service.callback("bob", "browser-bob", callback)).rejects.toMatchObject({
          code: "mcp_denied",
        });
        await expect(f.service.callback("alice", "wrong-browser", callback)).rejects.toMatchObject({
          code: "mcp_denied",
        });
        await f.service.callback("alice", "browser-alice", callback);
        await expect(f.service.callback("alice", "browser-alice", callback)).rejects.toMatchObject({
          code: "mcp_denied",
        });
        const alice = connectionBinding((await f.store.get("alice", f.server.id))!);
        const bob = await f.connect("bob", "operator");
        expect(f.gateway.access.get(await f.service.credential(alice))).toBe("reader");
        expect(f.gateway.access.get(await f.service.credential(bob))).toBe("operator");
        const a = (await f.store.get("alice", f.server.id))!,
          b = (await f.store.get("bob", f.server.id))!;
        expect(a.encrypted_payload).not.toContain(await f.service.credential(alice));
        await expect(
          f.store.decrypt({ ...b, encrypted_payload: a.encrypted_payload })
        ).rejects.toThrow();
      }));
    it("one durable refresh wins between independent service instances; rotation preserves grant identity", () =>
      factory(async (db) => {
        const f = await fixture(db);
        const binding = await f.connect();
        await f.expire();
        const second = new McpOAuthService(new McpConnectionStore(db, f.key), (request) =>
          f.gateway.fetch(request)
        );
        const tokens = await Promise.all([
          f.service.credential(binding),
          second.credential(binding),
        ]);
        expect(tokens[0]).toBe(tokens[1]);
        expect(f.gateway.refreshCount).toBe(1);
        expect((await f.store.get("alice", f.server.id))!.grant_revision).toBe(
          binding.grantRevision
        );
      }));
    it("disconnect during refresh wins over stale publication", () =>
      factory(async (db) => {
        const f = await fixture(db);
        const binding = await f.connect();
        await f.expire();
        let release!: () => void, entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        f.gateway.afterTokenExchange = async () => {
          entered();
          await gate;
        };
        const pending = f.service.credential(binding);
        const rejected = expect(pending).rejects.toMatchObject({ code: "mcp_context_changed" });
        await started;
        await f.store.disconnect("alice", f.server.id);
        release();
        await rejected;
        expect((await f.store.get("alice", f.server.id))!.status).toBe("disconnected");
      }));
    it("lost rotated response and expired claims require reconnect, never reuse refresh token", () =>
      factory(async (db) => {
        const f = await fixture(db);
        const binding = await f.connect();
        await f.expire();
        f.gateway.afterTokenExchange = async () => {
          throw new Error("lost after rotation");
        };
        await expect(f.service.credential(binding)).rejects.toMatchObject({
          code: "mcp_reconnect_required",
        });
        await expect(f.service.credential(binding)).rejects.toMatchObject({
          code: "mcp_reconnect_required",
        });
        expect(f.gateway.refreshCount).toBe(1);
        f.gateway.afterTokenExchange = undefined;
        const replacement = await f.connect();
        await f.expire();
        const row = (await f.store.get("alice", f.server.id))!;
        await f.store.claimRefresh(row, "crashed-isolate", Date.now() - MCP_REFRESH_STALE_MS - 1);
        await expect(f.service.credential(replacement)).rejects.toMatchObject({
          code: "mcp_reconnect_required",
        });
        expect(f.gateway.refreshCount).toBe(1);
      }));
    it("concurrent callbacks redeem once and reconnect invalidates previous transactions", () =>
      factory(async (db) => {
        const f = await fixture(db);
        const old = await f.authorize();
        const current = await f.authorize();
        await expect(f.service.callback("alice", "browser-alice", old)).rejects.toMatchObject({
          code: "mcp_denied",
        });
        const results = await Promise.allSettled([
          f.service.callback("alice", "browser-alice", current),
          f.service.callback("alice", "browser-alice", current),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      }));
    it("reconnect keeps the working grant until the new consent settles", () =>
      factory(async (db) => {
        const f = await fixture(db);
        const first = await f.connect();
        const token = await f.service.credential(first);
        // The user leaves the provider page without finishing.
        await f.authorize();
        expect(await f.store.get("alice", f.server.id)).toMatchObject({
          status: "connected",
          grant_revision: first.grantRevision,
        });
        expect(await f.service.credential(first)).toBe(token);
        const second = await f.connect("alice", "operator");
        expect(second.grantRevision).toBeGreaterThan(first.grantRevision);
        await expect(f.service.credential(first)).rejects.toMatchObject({
          code: "mcp_context_changed",
        });
        expect(f.gateway.access.get(await f.service.credential(second))).toBe("operator");
      }));
    it("a consent that fails to publish leaves the existing grant untouched", () =>
      factory(async (db) => {
        const f = await fixture(db);
        const binding = await f.connect();
        const failing: SqlDatabase = {
          prepare: (query) => db.prepare(query),
          batch: async () => {
            throw new Error("publication failed");
          },
        };
        const start = () =>
          new McpOAuthService(new McpConnectionStore(failing, f.key), (request) =>
            f.gateway.fetch(request)
          ).start(
            "alice",
            "browser-alice",
            f.server,
            "https://app.fixture.test/api/mcp-connections/oauth/callback"
          );
        const connected = await f.store.get("alice", f.server.id);
        await expect(start()).rejects.toThrow("publication failed");
        expect(await f.store.get("alice", f.server.id)).toEqual(connected);
        await f.service.credential(binding);
        // A grant the new client cannot use is replaced only together with publication.
        await db
          .prepare(
            "UPDATE mcp_connections SET client_id = 'retired-client' WHERE owner_id = 'alice'"
          )
          .run();
        const stale = await f.store.get("alice", f.server.id);
        await expect(start()).rejects.toThrow("publication failed");
        expect(await f.store.get("alice", f.server.id)).toEqual(stale);
        expect(await db.prepare("SELECT * FROM mcp_oauth_transactions").first()).toBeNull();
      }));
    it("disconnect prevents callback settlement after code consumption", () =>
      factory(async (db) => {
        const f = await fixture(db);
        const callback = await f.authorize();
        f.gateway.afterTokenExchange = async () => {
          await f.store.disconnect("alice", f.server.id);
        };
        await expect(f.service.callback("alice", "browser-alice", callback)).rejects.toMatchObject({
          code: "mcp_context_changed",
        });
        expect((await f.store.get("alice", f.server.id))!.status).toBe("disconnected");
      }));
    it.each(["logout", "expiry", "suspension", "profile"])(
      "%s during code exchange fences settlement",
      (change) =>
        factory(async (db) => {
          const f = await fixture(db);
          const callback = await f.authorize();
          f.gateway.afterTokenExchange = async () => {
            if (change === "logout")
              await db.prepare("DELETE FROM auth_sessions WHERE userId = 'alice'").run();
            if (change === "expiry")
              await db.prepare("UPDATE mcp_oauth_transactions SET expires_at = 0").run();
            if (change === "suspension")
              await db.prepare("UPDATE users SET suspended_at = 1 WHERE id = 'alice'").run();
            if (change === "profile")
              await f.registry.update(f.server.id, { url: `${f.gateway.origin}/changed` });
          };
          await expect(
            f.service.callback("alice", "browser-alice", callback)
          ).rejects.toMatchObject({ code: "mcp_context_changed" });
          expect((await f.store.get("alice", f.server.id))!.status).not.toBe("connected");
        })
    );
    it("reserves canonical ownership before publishing the OAuth transaction", () =>
      factory(async (db) => {
        const f = await fixture(db);
        await db
          .prepare(
            "INSERT INTO user_identities (id,user_id,provider,provider_user_id,created_at,updated_at) VALUES ('identity','alice','slack','external',1,1)"
          )
          .run();
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const pausedDb: SqlDatabase = {
          prepare: (query) => db.prepare(query),
          async batch(statements) {
            entered();
            await gate;
            return db.batch(statements);
          },
        };
        const oauth = new McpOAuthService(new McpConnectionStore(pausedDb, f.key), (request) =>
          f.gateway.fetch(request)
        );
        const pending = oauth.start(
          "alice",
          "browser-alice",
          f.server,
          "https://app.fixture.test/api/mcp-connections/oauth/callback"
        );
        // Canonical merges are what move an identity to another user.
        const merge = () => mergeUsers(db, { survivorId: "bob", loserId: "alice" });
        await started;
        try {
          expect(await db.prepare("SELECT * FROM mcp_oauth_transactions").first()).toBeNull();
          await expect(merge()).rejects.toThrow("Disconnect personal MCP");
          await expect(f.registry.delete(f.server.id)).rejects.toThrow("disconnect");
        } finally {
          release();
          await pending;
        }
        await f.store.disconnect("alice", f.server.id);
        await merge();
        expect(
          await db.prepare("SELECT user_id FROM user_identities WHERE id = 'identity'").first()
        ).toEqual({ user_id: "bob" });
      }));
    it("abandoned consent stops blocking ownership writes once its transaction window ends", () =>
      factory(async (db) => {
        const f = await fixture(db);
        await f.authorize("alice");
        await db
          .prepare(
            "INSERT INTO user_identities (id,user_id,provider,provider_user_id,created_at,updated_at) VALUES ('identity','alice','slack','external',1,1)"
          )
          .run();
        const relink = () =>
          db.prepare("UPDATE user_identities SET user_id = 'bob' WHERE id = 'identity'").run();
        await expect(relink()).rejects.toThrow();
        await expect(f.registry.delete(f.server.id)).rejects.toThrow("disconnect");
        await db.prepare("UPDATE mcp_connections SET updated_at = 0").run();
        await db.prepare("UPDATE mcp_oauth_transactions SET expires_at = 0").run();
        await relink();
        await f.registry.delete(f.server.id);
      }));
    it("canonical merge and relink fail atomically while a personal grant is live", () =>
      factory(async (db) => {
        const f = await fixture(db);
        await f.connect();
        await db
          .prepare(
            "INSERT INTO user_identities (id,user_id,provider,provider_user_id,created_at,updated_at) VALUES ('identity','alice','slack','external',1,1)"
          )
          .run();
        await expect(
          db.prepare("UPDATE user_identities SET user_id = 'bob' WHERE id = 'identity'").run()
        ).rejects.toThrow();
        await expect(db.prepare("DELETE FROM users WHERE id = 'alice'").run()).rejects.toThrow();
        expect((await f.store.get("alice", f.server.id))!.status).toBe("connected");
        await f.store.disconnect("alice", f.server.id);
        await db.prepare("UPDATE user_identities SET user_id = 'bob' WHERE id = 'identity'").run();
        expect(await f.store.get("bob", f.server.id)).toBeNull();
      }));
  });
}
