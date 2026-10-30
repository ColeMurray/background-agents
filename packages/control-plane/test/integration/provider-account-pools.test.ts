import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PROVIDER_ACCOUNT_POOL_MAX_SIZE } from "@open-inspect/shared/types/provider-accounts";
import { modelProviderAccountAdapterRegistry } from "../../src/auth/model-provider-account-default-adapters";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import {
  ProviderDefaultConstraintError,
  ProviderDefaultStore,
} from "../../src/db/provider-account-defaults";
import { SessionIndexStore } from "../../src/db/session-index";
import { resolveProviderAccountSelections } from "../../src/session/provider-account-resolution";
import { resolveSessionProviderAuth } from "../../src/session/provider-account-resolution";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth, serviceFetch } from "./helpers";

const FIRST = "1".repeat(32);
const SECOND = "2".repeat(32);

function accountId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

async function managementFetch(path: string, init?: { method?: string; body?: unknown }) {
  return serviceFetch(`https://test.local${path}`, {
    method: init?.method,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

describe("provider account pools", () => {
  beforeEach(cleanD1Tables);

  it("stores a max-size pool, rejects a larger one, and ignores ineligible accounts", async () => {
    const accounts = new ModelProviderAccountStore(env.DB);
    const defaults = new ProviderDefaultStore(env.DB);
    const ids = Array.from({ length: PROVIDER_ACCOUNT_POOL_MAX_SIZE + 1 }, (_, index) =>
      accountId(index + 1)
    );
    const disabledId = accountId(200);
    for (const [index, id] of ids.entries()) {
      await accounts.create({
        id,
        provider: "openai",
        displayName: `Pool ${index + 1}`,
        now: index + 1,
      });
    }
    await accounts.create({
      id: disabledId,
      provider: "openai",
      displayName: "Disabled",
      status: "disabled",
      now: 40,
    });
    const maxPool = ids.slice(0, PROVIDER_ACCOUNT_POOL_MAX_SIZE);

    await expect(
      defaults.setRouting(
        "openai",
        {
          unattendedMode: "provider_account",
          selection: { mode: "random", accountIds: [ids[0], disabledId] },
        },
        null,
        50,
        true
      )
    ).rejects.toBeInstanceOf(ProviderDefaultConstraintError);
    await expect(defaults.getRouting("openai")).resolves.toMatchObject({
      selection: { mode: "unconfigured" },
    });

    const stored = await defaults.setRouting(
      "openai",
      {
        unattendedMode: "api_key",
        selection: { mode: "random", accountIds: maxPool },
      },
      null,
      60,
      true
    );
    expect(stored.selection).toEqual({ mode: "random", accountIds: [...maxPool].sort() });
    await expect(defaults.list()).resolves.toEqual([]);
    await expect(defaults.get("openai")).resolves.toBeNull();

    await expect(
      defaults.setRouting(
        "openai",
        {
          unattendedMode: "provider_account",
          selection: { mode: "random", accountIds: ids },
        },
        null,
        70,
        true
      )
    ).rejects.toBeInstanceOf(ProviderDefaultConstraintError);
    await expect(defaults.getRouting("openai")).resolves.toMatchObject({
      unattendedMode: "api_key",
      selection: { mode: "random", accountIds: [...maxPool].sort() },
    });

    await defaults.set("openai", ids[0], "provider_account", null, 80);
    await expect(defaults.getRouting("openai")).resolves.toMatchObject({
      selection: { mode: "fixed", accountId: ids[0] },
    });
    const members = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM model_provider_account_pool_members"
    ).first<{ count: number }>();
    expect(members?.count).toBe(0);
  });

  it("keeps a retried session on its first draw and issues Codex credentials for that account", async () => {
    const accounts = new ModelProviderAccountStore(env.DB);
    const defaults = new ProviderDefaultStore(env.DB);
    const now = Date.now();
    await accounts.create({
      id: FIRST,
      provider: "openai",
      displayName: "First",
      externalAccountId: "acct-integration",
      now,
    });
    await accounts.create({
      id: SECOND,
      provider: "openai",
      displayName: "Second",
      externalAccountId: "acct-second",
      now,
    });
    const credentials = new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!);
    await credentials.create({
      providerAccountId: FIRST,
      provider: "openai",
      credentialSchemaVersion: 1,
      payload: {
        refreshToken: "integration-openai-refresh",
        accessToken: "stale-first",
        accountId: "acct-integration",
        accessTokenExpiresAt: now - 1_000,
      },
      accessTokenExpiresAt: now - 1_000,
      now,
    });
    await credentials.create({
      providerAccountId: SECOND,
      provider: "openai",
      credentialSchemaVersion: 1,
      payload: {
        refreshToken: "other-account-refresh",
        accessToken: "stale-second",
        accountId: "acct-second",
        accessTokenExpiresAt: now - 1_000,
      },
      accessTokenExpiresAt: now - 1_000,
      now,
    });
    await defaults.setRouting(
      "openai",
      {
        unattendedMode: "provider_account",
        selection: { mode: "random", accountIds: [SECOND, FIRST] },
      },
      null,
      now,
      true
    );

    const stores = {
      defaults,
      routing: defaults,
      random: () => 0,
      accounts,
      adapters: modelProviderAccountAdapterRegistry,
    };
    const drawn = await resolveProviderAccountSelections(
      { harness: "codex", model: "openai/gpt-5.6-sol", unattended: false, randomEnabled: true },
      stores
    );
    expect(drawn.find((item) => item.provider === "openai")).toMatchObject({
      authMode: "provider_account",
      providerAccountId: FIRST,
      selectionSource: "installation_random",
    });

    const sessionId = `pool-retry-${now}`;
    await new SessionIndexStore(env.DB).create({
      id: sessionId,
      harness: "codex",
      ownerTeamId: null,
      visibility: "workspace",
      title: null,
      repoOwner: null,
      repoName: null,
      model: "openai/gpt-5.6-sol",
      reasoningEffort: null,
      baseBranch: null,
      repositories: [],
      status: "created",
      providerAuth: drawn,
      createdAt: now,
      updatedAt: now,
    });
    await defaults.setRouting(
      "openai",
      {
        unattendedMode: "provider_account",
        selection: { mode: "random", accountIds: [SECOND] },
      },
      null,
      now + 1,
      true
    );
    const retried = await resolveSessionProviderAuth(env.DB, {
      sessionId,
      harness: "codex",
      model: "openai/gpt-5.6-sol",
      unattended: false,
      randomEnabled: true,
    });
    expect([...retried].sort((left, right) => left.provider.localeCompare(right.provider))).toEqual(
      [...drawn].sort((left, right) => left.provider.localeCompare(right.provider))
    );

    const { stub } = await initNamedSession(`${sessionId}-broker`, {
      harness: "codex",
      model: "openai/gpt-5.6-sol",
      providerAuth: drawn,
    });
    await seedSandboxAuth(stub, { authToken: "sandbox-secret", sandboxId: "sandbox-pool" });
    const issued = await SELF.fetch(
      `https://test.local/sessions/${sessionId}-broker/provider-auth/openai/access-token`,
      { method: "POST", headers: { Authorization: "Bearer sandbox-secret" } }
    );
    expect(issued.status).toBe(200);
    expect(await issued.json()).toMatchObject({
      accessToken: "integration-openai-access-token",
      externalAccountId: "acct-integration",
    });
  });

  it("reports random support from the server and refuses pool writes while it is off", async () => {
    const listed = await managementFetch("/model-provider-account-routing");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(listed.json()).resolves.toEqual({
      randomEnabled: false,
      routing: [
        {
          provider: "openai",
          unattendedMode: "provider_account",
          selection: { mode: "unconfigured" },
        },
        {
          provider: "xai",
          unattendedMode: "provider_account",
          selection: { mode: "unconfigured" },
        },
        {
          provider: "anthropic",
          unattendedMode: "provider_account",
          selection: { mode: "unconfigured" },
        },
      ],
    });

    const denied = await managementFetch("/model-provider-account-routing/openai", {
      method: "PUT",
      body: {
        unattendedMode: "provider_account",
        selection: { mode: "random", accountIds: [FIRST, SECOND] },
      },
    });
    expect(denied.status).toBe(409);
    await expect(denied.json()).resolves.toMatchObject({
      error: "Random provider allocation is not enabled",
    });
  });
});
