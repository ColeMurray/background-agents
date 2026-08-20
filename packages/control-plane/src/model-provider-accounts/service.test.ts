import { describe, expect, it, vi } from "vitest";
import {
  ModelProviderAccountAdapterRegistry,
  ProviderRefreshError,
  type ModelProviderAccountAdapter,
  type ProviderConnectionResult,
  type ProviderRefreshResult,
} from "../auth/model-provider-account-adapters";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import type { ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import {
  ModelProviderAccountService,
  type ModelProviderAccountServiceAccountStore,
  type ModelProviderAccountServiceCredentialStore,
} from "./service";

const ACCOUNT_ID = "11111111111111111111111111111111";

type Credential = { refreshToken: string; accessToken?: string };

function adapter(
  options: {
    connect?: ProviderConnectionResult<Credential>;
    refresh?: ProviderRefreshResult<Credential>;
  } = {}
): ModelProviderAccountAdapter<Credential, unknown> {
  return {
    provider: "openai",
    credentialSchemaVersion: 1,
    refreshBufferMs: 300_000,
    parseConnectInput: (input) => input,
    connect: vi.fn(
      async () =>
        options.connect ?? {
          credential: { refreshToken: "rotated-secret", accessToken: "access-secret" },
          externalAccountId: "acct-1",
          accessTokenExpiresAt: 2_000,
        }
    ),
    parseCredential: (value) => value as Credential,
    refresh: vi.fn(
      async () =>
        options.refresh ?? {
          credential: { refreshToken: "verified-secret", accessToken: "verified-access" },
          accessToken: "verified-access",
          accessTokenExpiresAt: 3_000,
          externalAccountId: "acct-1",
        }
    ),
    cachedAccess: vi.fn(() => null),
    runtimeMetadata: vi.fn(() => ({})),
  };
}

function providerAccount(overrides: Partial<ModelProviderAccount> = {}): ModelProviderAccount {
  return {
    id: ACCOUNT_ID,
    provider: "openai",
    displayName: "Team ChatGPT",
    externalAccountId: "acct-1",
    status: "active",
    createdBy: "user-1",
    updatedBy: "user-1",
    lastVerifiedAt: 1,
    lastUsedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

function stores(account: ModelProviderAccount | null = providerAccount()): {
  accounts: ModelProviderAccountServiceAccountStore;
  credentials: ModelProviderAccountServiceCredentialStore;
  atomicWriter: ModelProviderAccountAtomicWriter;
} {
  return {
    accounts: {
      list: vi.fn(async () => []),
      getById: vi.fn(async () => account),
      findByExternalIdentity: vi.fn(async () => null),
      updateDetails: vi.fn(async () => true),
      setStatus: vi.fn(async () => true),
      archive: vi.fn(async () => true),
    },
    credentials: {
      tryBeginExchange: vi.fn(async () => ({ acquired: true as const, generation: 1 })),
      clearSafeFailure: vi.fn(async () => true),
      readCredentialState: vi.fn(async () => ({
        payload: { refreshToken: "stored-secret" },
        credentialSchemaVersion: 1,
        credentialVersion: 1,
        exchangeGeneration: 0,
        exchangeState: "idle" as const,
        exchangeOwner: null,
        exchangeStartedAt: null,
        accessTokenExpiresAt: null,
        updatedAt: 1,
      })),
    },
    atomicWriter: {
      createAccountWithCredential: vi.fn(async (input) => ({
        id: input.id,
        provider: input.provider,
        displayName: input.displayName,
        externalAccountId: input.externalAccountId,
        status: "active" as const,
        createdBy: input.actorId,
        updatedBy: input.actorId,
        lastVerifiedAt: input.now,
        lastUsedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
        archivedAt: null,
      })),
      reconnectCredentialAndAccount: vi.fn(async () => true),
      completeVerificationCredentialAndAccount: vi.fn(async () => true),
      fenceExchangeAndRequireReconnect: vi.fn(async () => true),
    },
  };
}

function createService(
  store: ReturnType<typeof stores>,
  registry: ModelProviderAccountAdapterRegistry,
  dependencies: { generateId: () => string; now: () => number }
) {
  return new ModelProviderAccountService(
    store.accounts,
    store.credentials,
    store.atomicWriter,
    registry,
    dependencies
  );
}

describe("ModelProviderAccountService", () => {
  it("connects through the adapter and never returns credentials", async () => {
    const store = stores();
    const service = createService(store, new ModelProviderAccountAdapterRegistry([adapter()]), {
      generateId: () => ACCOUNT_ID,
      now: () => 1_000,
    });

    const account = await service.create(
      {
        provider: "openai",
        displayName: "Team ChatGPT",
        refreshToken: "submitted-secret",
        accountId: "acct-1",
      },
      "user-1"
    );

    expect(account).toMatchObject({
      account: { id: ACCOUNT_ID, provider: "openai", status: "active" },
      reconnectedExisting: false,
    });
    expect(JSON.stringify(account)).not.toContain("secret");
    expect(store.atomicWriter.createAccountWithCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ACCOUNT_ID,
        provider: "openai",
        credential: expect.objectContaining({
          payload: { refreshToken: "rotated-secret", accessToken: "access-secret" },
        }),
      })
    );
  });

  it.each([
    [undefined, "could not be verified"],
    ["acct-other", "did not match"],
  ] as const)(
    "rejects an untrusted OpenAI create identity %s",
    async (externalAccountId, message) => {
      const store = stores(null);
      const service = createService(
        store,
        new ModelProviderAccountAdapterRegistry([
          adapter({
            connect: {
              credential: { refreshToken: "rotated-secret" },
              externalAccountId,
            },
          }),
        ]),
        { generateId: () => ACCOUNT_ID, now: () => 1_000 }
      );

      await expect(
        service.create(
          {
            provider: "openai",
            displayName: "Team ChatGPT",
            refreshToken: "submitted-secret",
            accountId: "acct-1",
          },
          "user-1"
        )
      ).rejects.toThrow(message);
      expect(store.atomicWriter.createAccountWithCredential).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, "acct-other"] as const)(
    "rejects an untrusted OpenAI reconnect identity %s before persistence",
    async (externalAccountId) => {
      const store = stores();
      const service = createService(
        store,
        new ModelProviderAccountAdapterRegistry([
          adapter({
            connect: {
              credential: { refreshToken: "rotated-secret" },
              externalAccountId,
            },
          }),
        ]),
        { generateId: () => ACCOUNT_ID, now: () => 1_000 }
      );

      await expect(
        service.reconnect(
          ACCOUNT_ID,
          {
            provider: "openai",
            refreshToken: "submitted-secret",
            accountId: "acct-1",
          },
          "user-1"
        )
      ).rejects.toThrow(/identity/);
      expect(store.credentials.readCredentialState).not.toHaveBeenCalled();
      expect(store.atomicWriter.reconnectCredentialAndAccount).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, "acct-other"] as const)(
    "rejects an untrusted OpenAI verify identity %s before persistence",
    async (externalAccountId) => {
      const store = stores();
      const service = createService(
        store,
        new ModelProviderAccountAdapterRegistry([
          adapter({
            refresh: {
              credential: { refreshToken: "verified-secret" },
              accessToken: "verified-access",
              accessTokenExpiresAt: 3_000,
              externalAccountId,
            },
          }),
        ]),
        { generateId: () => ACCOUNT_ID, now: () => 1_000 }
      );

      await expect(service.verify(ACCOUNT_ID, "user-1")).rejects.toThrow(/identity/);
      expect(store.atomicWriter.completeVerificationCredentialAndAccount).not.toHaveBeenCalled();
    }
  );

  it("claims verification before dispatch and atomically commits credential and account state", async () => {
    const store = stores();
    const providerAdapter = adapter({
      refresh: {
        credential: { refreshToken: "verified-secret", accessToken: "verified-access" },
        accessToken: "verified-access",
        accessTokenExpiresAt: 3_000,
        externalAccountId: "acct-1",
      },
    });
    const service = createService(
      store,
      new ModelProviderAccountAdapterRegistry([providerAdapter]),
      { generateId: () => ACCOUNT_ID, now: () => 1_000 }
    );

    await service.verify(ACCOUNT_ID, "user-1");

    expect(store.credentials.tryBeginExchange).toHaveBeenCalledWith(
      ACCOUNT_ID,
      1,
      ACCOUNT_ID,
      "active",
      1_000
    );
    expect(providerAdapter.refresh).toHaveBeenCalledTimes(1);
    expect(store.atomicWriter.completeVerificationCredentialAndAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: ACCOUNT_ID,
        expectedCredentialVersion: 1,
        exchangeGeneration: 1,
        exchangeOwner: ACCOUNT_ID,
        externalAccountId: "acct-1",
        status: "active",
        actorId: "user-1",
        lastVerifiedAt: 1_000,
        payload: expect.objectContaining({ refreshToken: "verified-secret" }),
      })
    );
    expect(store.accounts.setStatus).not.toHaveBeenCalled();
  });

  it("does not dispatch verification when another worker owns the durable claim", async () => {
    const store = stores();
    vi.mocked(store.credentials.tryBeginExchange).mockResolvedValue({ acquired: false });
    const providerAdapter = adapter();
    const service = createService(
      store,
      new ModelProviderAccountAdapterRegistry([providerAdapter]),
      { generateId: () => ACCOUNT_ID, now: () => 1_000 }
    );

    await expect(service.verify(ACCOUNT_ID, "user-1")).rejects.toMatchObject({ status: 409 });
    expect(providerAdapter.refresh).not.toHaveBeenCalled();
  });

  it("reconnects credential and account identity in one persistence operation", async () => {
    const store = stores();
    const service = createService(
      store,
      new ModelProviderAccountAdapterRegistry([
        adapter({
          connect: {
            credential: { refreshToken: "rotated-secret", accessToken: "new-access" },
            externalAccountId: "acct-1",
            accessTokenExpiresAt: 3_000,
          },
        }),
      ]),
      { generateId: () => ACCOUNT_ID, now: () => 1_000 }
    );

    await service.reconnect(
      ACCOUNT_ID,
      { provider: "openai", refreshToken: "submitted-secret", accountId: "acct-1" },
      "user-1"
    );

    expect(store.atomicWriter.reconnectCredentialAndAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountId: ACCOUNT_ID,
        expectedCredentialVersion: 1,
        externalAccountId: "acct-1",
        status: "active",
        actorId: "user-1",
      })
    );
    expect(store.accounts.setStatus).not.toHaveBeenCalled();
  });

  it("preflights duplicate identity and safely reconnects the existing account", async () => {
    const existing = providerAccount({ id: "22222222222222222222222222222222" });
    const store = stores(existing);
    vi.mocked(store.accounts.findByExternalIdentity).mockResolvedValue(existing);
    const service = createService(store, new ModelProviderAccountAdapterRegistry([adapter()]), {
      generateId: () => ACCOUNT_ID,
      now: () => 1_000,
    });

    const result = await service.create(
      {
        provider: "openai",
        displayName: "Duplicate",
        refreshToken: "submitted-secret",
        accountId: "acct-1",
      },
      "user-1"
    );

    expect(result).toMatchObject({ account: { id: existing.id }, reconnectedExisting: true });
    expect(store.atomicWriter.createAccountWithCredential).not.toHaveBeenCalled();
    expect(store.atomicWriter.reconnectCredentialAndAccount).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: existing.id })
    );
  });

  it("recovers a post-exchange uniqueness race through safe reconnect", async () => {
    const winner = providerAccount({ id: "22222222222222222222222222222222" });
    const store = stores(winner);
    vi.mocked(store.accounts.findByExternalIdentity)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    vi.mocked(store.atomicWriter.createAccountWithCredential).mockRejectedValue(
      new Error("UNIQUE constraint failed: model_provider_accounts.provider")
    );
    const service = createService(store, new ModelProviderAccountAdapterRegistry([adapter()]), {
      generateId: () => ACCOUNT_ID,
      now: () => 1_000,
    });

    await expect(
      service.create(
        {
          provider: "openai",
          displayName: "Racing duplicate",
          refreshToken: "submitted-secret",
          accountId: "acct-1",
        },
        "user-1"
      )
    ).resolves.toMatchObject({ account: { id: winner.id }, reconnectedExisting: true });
    expect(store.atomicWriter.reconnectCredentialAndAccount).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: winner.id })
    );
  });

  it("returns consumed-credential guidance when duplicate recovery cannot persist safely", async () => {
    const existing = providerAccount({ id: "22222222222222222222222222222222" });
    const store = stores(existing);
    vi.mocked(store.accounts.findByExternalIdentity).mockResolvedValue(existing);
    vi.mocked(store.atomicWriter.reconnectCredentialAndAccount).mockResolvedValue(false);
    const service = createService(store, new ModelProviderAccountAdapterRegistry([adapter()]), {
      generateId: () => ACCOUNT_ID,
      now: () => 1_000,
    });

    const error = await service
      .create(
        {
          provider: "openai",
          displayName: "Duplicate",
          refreshToken: "submitted-secret",
          accountId: "acct-1",
        },
        "user-1"
      )
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ status: 409 });
    expect((error as Error).message).toMatch(/may have been consumed.*fresh credential/i);
    expect((error as Error).message).not.toContain("submitted-secret");
    expect(store.atomicWriter.createAccountWithCredential).not.toHaveBeenCalled();
  });

  it("fences a consumed verification result when its atomic commit fails", async () => {
    const store = stores();
    vi.mocked(store.atomicWriter.completeVerificationCredentialAndAccount).mockRejectedValue(
      new Error("D1 unavailable")
    );
    const service = createService(store, new ModelProviderAccountAdapterRegistry([adapter()]), {
      generateId: () => ACCOUNT_ID,
      now: () => 1_000,
    });

    const error = await service.verify(ACCOUNT_ID, "user-1").catch((cause: unknown) => cause);

    expect(store.atomicWriter.fenceExchangeAndRequireReconnect).toHaveBeenCalledWith({
      providerAccountId: ACCOUNT_ID,
      credentialVersion: 1,
      exchangeGeneration: 1,
      exchangeOwner: ACCOUNT_ID,
      now: 1_000,
    });
    expect(error).toMatchObject({ status: 409 });
    expect((error as Error).message).toMatch(/may have been consumed.*fresh credential/i);
    expect((error as Error).message).not.toContain("verified-secret");
  });

  it.each(["ambiguous", "unauthorized"] as const)(
    "atomically requires reconnect after a %s verification refresh failure",
    async (classification) => {
      const store = stores();
      const providerAdapter = adapter();
      vi.mocked(providerAdapter.refresh).mockRejectedValue(
        new ProviderRefreshError("refresh failed", classification)
      );
      const service = createService(
        store,
        new ModelProviderAccountAdapterRegistry([providerAdapter]),
        { generateId: () => ACCOUNT_ID, now: () => 1_000 }
      );

      await expect(service.verify(ACCOUNT_ID, "user-1")).rejects.toBeInstanceOf(
        ProviderRefreshError
      );
      expect(store.atomicWriter.fenceExchangeAndRequireReconnect).toHaveBeenCalledWith({
        providerAccountId: ACCOUNT_ID,
        credentialVersion: 1,
        exchangeGeneration: 1,
        exchangeOwner: ACCOUNT_ID,
        now: 1_000,
      });
    }
  );
});
