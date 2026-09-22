import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../src/db/sql-database";
import { ProviderAccountRoutingStore } from "../src/db/provider-account-routing";
import { ProviderDefaultStore } from "../src/db/provider-account-defaults";
import { ModelProviderAccountStore } from "../src/db/model-provider-accounts";
import { SessionProviderBindingStore } from "../src/db/session-provider-binding";
import { SessionIndexStore, type SessionEntry } from "../src/db/session-index";
import { resolveSessionProviderAuth } from "../src/session/provider-account-resolution";

const a = "a".repeat(32),
  b = "b".repeat(32);
export function rotationStorageContract(database: () => SqlDatabase) {
  describe("provider rotation SQL contract", () => {
    async function seed() {
      const db = database();
      const accounts = new ModelProviderAccountStore(db);
      await accounts.create({ id: a, provider: "openai", displayName: "A", now: 1 });
      await accounts.create({ id: b, provider: "openai", displayName: "B", now: 1 });
      return { db, policies: new ProviderAccountRoutingStore(db), accounts };
    }
    it("commits exactly one CAS winner with matching members and audit", async () => {
      const { db, policies } = await seed();
      const attempts = await Promise.allSettled([
        policies.set(
          "openai",
          {
            expectedPolicyRevision: 0,
            unattendedMode: "provider_account",
            selection: { mode: "random", accountIds: [a, b] },
          },
          null
        ),
        policies.set(
          "openai",
          {
            expectedPolicyRevision: 0,
            unattendedMode: "api_key",
            selection: { mode: "fixed", accountId: a },
          },
          null
        ),
      ]);
      expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const policy = await policies.get("openai");
      expect(policy.policyRevision).toBe(1);
      const members = await db
        .prepare("SELECT provider_account_id FROM model_provider_account_policy_members")
        .all<{ provider_account_id: string }>();
      expect(members.results.map((row) => row.provider_account_id).sort()).toEqual(
        policy.selection.mode === "random" ? [a, b] : []
      );
      expect(
        await db.prepare("SELECT count(*) AS n FROM model_provider_account_policy_audit").first()
      ).toEqual({ n: 1 });
    });
    it("keeps monotonically versioned tombstones and rejects stale recreation", async () => {
      const { policies } = await seed();
      await policies.set(
        "openai",
        {
          expectedPolicyRevision: 0,
          unattendedMode: "provider_account",
          selection: { mode: "fixed", accountId: a },
        },
        null
      );
      await policies.set(
        "openai",
        {
          expectedPolicyRevision: 1,
          unattendedMode: "api_key",
          selection: { mode: "unconfigured" },
        },
        null
      );
      await expect(
        policies.set(
          "openai",
          {
            expectedPolicyRevision: 0,
            unattendedMode: "provider_account",
            selection: { mode: "fixed", accountId: b },
          },
          null
        )
      ).rejects.toThrow();
      expect(await policies.get("openai")).toMatchObject({
        policyRevision: 2,
        selection: { mode: "unconfigured" },
      });
      await policies.set(
        "openai",
        {
          expectedPolicyRevision: 2,
          unattendedMode: "provider_account",
          selection: { mode: "fixed", accountId: b },
        },
        null
      );
      expect((await policies.get("openai")).policyRevision).toBe(3);
    });
    it("legacy writers cannot silently downgrade random and unavailable members cannot win", async () => {
      const { db, policies } = await seed();
      await policies.set(
        "openai",
        {
          expectedPolicyRevision: 0,
          unattendedMode: "provider_account",
          selection: { mode: "random", accountIds: [a] },
        },
        null
      );
      await expect(
        new ProviderDefaultStore(db).set("openai", b, "api_key", null)
      ).rejects.toThrow();
      await db
        .prepare("UPDATE model_provider_accounts SET status = 'disabled' WHERE id = ?")
        .bind(b)
        .run();
      await expect(
        policies.set(
          "openai",
          {
            expectedPolicyRevision: 1,
            unattendedMode: "provider_account",
            selection: { mode: "random", accountIds: [b] },
          },
          null
        )
      ).rejects.toThrow();
      expect(await policies.get("openai")).toMatchObject({
        policyRevision: 1,
        selection: { mode: "random", accountIds: [a] },
      });
    });
    it("binding commit is CAS-protected, audited and idempotent without changing allocation provenance", async () => {
      const { db } = await seed();
      await db
        .prepare(
          "INSERT INTO sessions (id, title, model, status, spawn_source, spawn_depth, created_at, updated_at) VALUES ('session', 'test', 'openai/gpt-5', 'active', 'user', 0, 1, 1)"
        )
        .run();
      await db
        .prepare(
          "UPDATE session_model_provider_auth SET auth_mode = 'provider_account', provider_account_id = ?, selection_source = 'installation_random', allocation_policy_revision = 9 WHERE session_id = 'session' AND provider = 'openai'"
        )
        .bind(a)
        .run();
      const bindings = new SessionProviderBindingStore(db);
      const input = {
        sessionId: "session",
        provider: "openai" as const,
        operationId: "switch",
        actorId: "actor",
        sourceAccountId: a,
        targetAccountId: b,
        expectedBindingRevision: 1,
      };
      await bindings.commit(input);
      await bindings.commit(input);
      await expect(
        bindings.deliverEvents("session", () => {
          throw new Error("event store unavailable");
        })
      ).rejects.toThrow("event store unavailable");
      const events: unknown[] = [];
      await bindings.deliverEvents("session", (event) => {
        events.push(event);
      });
      await bindings.deliverEvents("session", (event) => {
        events.push(event);
      });
      expect(events).toEqual([
        expect.objectContaining({
          type: "provider_account_changed",
          operationId: "switch",
          sourceAccountId: a,
          targetAccountId: b,
          bindingRevision: 2,
          actorId: "actor",
        }),
      ]);
      await expect(bindings.commit({ ...input, targetAccountId: a })).rejects.toThrow("conflict");
      await expect(bindings.commit({ ...input, operationId: "stale" })).rejects.toThrow("stale");
      expect(
        await new SessionIndexStore(db).getProviderAuthForProvider("session", "openai")
      ).toMatchObject({
        providerAccountId: b,
        bindingRevision: 2,
        allocationPolicyRevision: 9,
        lastSwitchOperationId: "switch",
      });
      expect(
        await db.prepare("SELECT count(*) AS n FROM session_provider_account_switches").first()
      ).toEqual({ n: 1 });
    });

    it("same-ID creation reuse survives disabled random allocation and rejects conflicting intent", async () => {
      const { db } = await seed();
      const index = new SessionIndexStore(db);
      const input: SessionEntry = {
        id: "stable",
        title: null,
        repoOwner: null,
        repoName: null,
        baseBranch: "main",
        model: "openai/gpt-5",
        reasoningEffort: null,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
        creationIntentHash: "intent",
      };
      expect(await index.create(input)).toBe("created");
      await db
        .prepare(
          "UPDATE session_model_provider_auth SET auth_mode = 'provider_account', provider_account_id = ?, selection_source = 'installation_random' WHERE session_id = 'stable' AND provider = 'openai'"
        )
        .bind(a)
        .run();
      await index.updateStatus("stable", "active");
      expect(await index.create(input)).toBe("reused");
      await expect(index.create({ ...input, creationIntentHash: "different" })).rejects.toThrow(
        "intent_conflict"
      );
      const resolved = await resolveSessionProviderAuth(db, {
        sessionId: "stable",
        harness: "opencode",
        unattended: false,
        randomEnabled: false,
      });
      expect(resolved).toContainEqual(
        expect.objectContaining({
          provider: "openai",
          providerAccountId: a,
          selectionSource: "installation_random",
        })
      );
      expect((await index.get("stable"))?.status).toBe("active");
    });

    it("child admission copies the current binding atomically rather than a stale route snapshot", async () => {
      const { db } = await seed();
      const index = new SessionIndexStore(db);
      const parent: SessionEntry = {
        id: "parent",
        title: null,
        repoOwner: null,
        repoName: null,
        baseBranch: "main",
        model: "openai/gpt-5",
        reasoningEffort: null,
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      };
      await index.create(parent);
      const stale = (await index.getCompleteProviderAuth("parent")).map((auth) => ({
        ...auth,
        inheritedFromSessionId: "parent",
      }));
      await db
        .prepare(
          "UPDATE session_model_provider_auth SET auth_mode = 'provider_account', provider_account_id = ? WHERE session_id = 'parent' AND provider = 'openai'"
        )
        .bind(b)
        .run();
      await index.create({
        ...parent,
        id: "child",
        parentSessionId: "parent",
        creationIntentHash: "child-intent",
        providerAuth: stale,
      });
      expect(await index.getProviderAuthForProvider("child", "openai")).toMatchObject({
        authMode: "provider_account",
        providerAccountId: b,
        bindingRevision: 1,
      });
    });
  });
}
