import { describe, expect, it, vi } from "vitest";
import {
  ModelProviderAccountAdapterRegistry,
  ProviderIdentityError,
  ProviderRefreshError,
  type ModelProviderAccountAdapter,
  type ProviderConnectionResult,
  type ProviderRefreshResult,
} from "../auth/model-provider-account-adapters";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import type { ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import { XaiModelProviderAccountAdapter } from "../auth/model-provider-account-xai-adapter";
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
  const validateExternalIdentity = (actual: string | undefined, expected: string | null) => {
    if (!actual) {
      throw new ProviderIdentityError("OpenAI account identity could not be verified");
    }
    if (!expected || actual !== expected) {
      throw new ProviderIdentityError("OpenAI account identity did not match");
    }
  };
  return {
    provider: "openai",
    credentialSchemaVersion: 1,
    refreshBufferMs: 300_000,
    parseConnectInput: (input) => input,
    connect: vi.fn(async (input) => {
      const result = options.connect ?? {
        credential: { refreshToken: "rotated-secret", accessToken: "access-secret" },
        externalAccountId: "acct-1",
        accessTokenExpiresAt: 2_000,
      };
      const accountId =
        input && typeof input === "object" && "accountId" in input ? String(input.accountId) : null;
      if (accountId) validateExternalIdentity(result.externalAccountId, accountId);
      return result;
    }),
    parseCredential: vi.fn((value) => value as Credential),
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
    validateReconnectInputIdentity: vi.fn((input, expectedExternalAccountId) => {
      const accountId =
        input && typeof input === "object" && "accountId" in input ? String(input.accountId) : null;
      if (expectedExternalAccountId && accountId !== expectedExternalAccountId) {
        throw new ProviderIdentityError("OpenAI account identity did not match");
      }
    }),
    runtimeMetadata: vi.fn(() => ({})),
    validateExternalIdentity,
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
      finalizeDeviceAuthorizationCreate: vi.fn(async () => ({ type: "created" as const })),
      finalizeDeviceAuthorizationReconnect: vi.fn(async () => ({ type: "connected" as const })),
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

  it("does not dispatch verification for an account that requires reconnect", async () => {
    const store = stores(providerAccount({ status: "reconnect_required" }));
    const providerAdapter = adapter();
    const service = createService(
      store,
      new ModelProviderAccountAdapterRegistry([providerAdapter]),
      { generateId: () => ACCOUNT_ID, now: () => 1_000 }
    );

    await expect(service.verify(ACCOUNT_ID, "user-1")).rejects.toMatchObject({ status: 409 });
    expect(providerAdapter.refresh).not.toHaveBeenCalled();
    expect(store.credentials.readCredentialState).not.toHaveBeenCalled();
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

  it("rejects identity-bound xAI reconnects through the adapter before consuming credentials", async () => {
    const store = stores(providerAccount({ provider: "xai", externalAccountId: "xai-account" }));
    const refresh = vi.fn();
    const service = createService(
      store,
      new ModelProviderAccountAdapterRegistry([new XaiModelProviderAccountAdapter(refresh)]),
      { generateId: () => ACCOUNT_ID, now: () => 1_000 }
    );

    await expect(
      service.reconnect(ACCOUNT_ID, { provider: "xai", refreshToken: "submitted-secret" }, "user-1")
    ).rejects.toMatchObject({
      status: 409,
      message: "Identity-bound xAI accounts must reconnect through device authorization",
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(store.credentials.readCredentialState).not.toHaveBeenCalled();
  });

  it("keeps legacy identity-unbound xAI reconnects compatible", async () => {
    const store = stores(providerAccount({ provider: "xai", externalAccountId: null }));
    const refresh = vi.fn().mockResolvedValue({
      access_token: "new-access",
      refresh_token: "rotated-secret",
      expires_in: 120,
    });
    const service = createService(
      store,
      new ModelProviderAccountAdapterRegistry([new XaiModelProviderAccountAdapter(refresh)]),
      { generateId: () => ACCOUNT_ID, now: () => 1_000 }
    );

    await service.reconnect(
      ACCOUNT_ID,
      { provider: "xai", refreshToken: "submitted-secret" },
      "user-1"
    );

    expect(refresh).toHaveBeenCalledOnce();
    expect(store.atomicWriter.reconnectCredentialAndAccount).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "xai", externalAccountId: null })
    );
  });

  it("rejects archived reconnects before consuming the submitted credential", async () => {
    const store = stores(providerAccount({ archivedAt: 999, status: "reconnect_required" }));
    const providerAdapter = adapter();
    const service = createService(
      store,
      new ModelProviderAccountAdapterRegistry([providerAdapter]),
      { generateId: () => ACCOUNT_ID, now: () => 1_000 }
    );

    await expect(
      service.reconnect(
        ACCOUNT_ID,
        { provider: "openai", refreshToken: "submitted-secret", accountId: "acct-1" },
        "user-1"
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(providerAdapter.connect).not.toHaveBeenCalled();
    expect(store.credentials.readCredentialState).not.toHaveBeenCalled();
  });

  it("maps only the default-account constraint for status and archive writes", async () => {
    const store = stores();
    const service = createService(store, new ModelProviderAccountAdapterRegistry([adapter()]), {
      generateId: () => ACCOUNT_ID,
      now: () => 1_000,
    });
    vi.mocked(store.accounts.setStatus).mockRejectedValueOnce(
      new Error("provider default account must remain active")
    );
    vi.mocked(store.accounts.archive).mockRejectedValueOnce(
      new Error("provider default account must remain active")
    );

    await expect(service.setStatus(ACCOUNT_ID, "disabled", "user-1")).rejects.toMatchObject({
      status: 409,
      message: "A default account must remain active",
    });
    await expect(service.archive(ACCOUNT_ID, "user-1")).rejects.toMatchObject({
      status: 409,
      message: "A default account cannot be archived",
    });
  });

  it("preserves unexpected status and archive storage failures", async () => {
    const store = stores();
    const service = createService(store, new ModelProviderAccountAdapterRegistry([adapter()]), {
      generateId: () => ACCOUNT_ID,
      now: () => 1_000,
    });
    const statusFailure = new Error("D1 unavailable while updating status");
    const archiveFailure = new Error("D1 unavailable while archiving");
    vi.mocked(store.accounts.setStatus).mockRejectedValueOnce(statusFailure);
    vi.mocked(store.accounts.archive).mockRejectedValueOnce(archiveFailure);

    await expect(service.setStatus(ACCOUNT_ID, "disabled", "user-1")).rejects.toBe(statusFailure);
    await expect(service.archive(ACCOUNT_ID, "user-1")).rejects.toBe(archiveFailure);
  });

  it("keeps archive idempotent when no row changes", async () => {
    const store = stores();
    vi.mocked(store.accounts.archive).mockResolvedValue(false);
    const service = createService(store, new ModelProviderAccountAdapterRegistry([adapter()]), {
      generateId: () => ACCOUNT_ID,
      now: () => 1_000,
    });

    await expect(service.archive(ACCOUNT_ID, "user-1")).resolves.toBeUndefined();
  });

  it("safely reconnects an existing account with the trusted external identity", async () => {
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

      await expect(service.verify(ACCOUNT_ID, "user-1")).rejects.toMatchObject({
        status: 409,
        message: "Provider account requires reconnection",
      });
      expect(store.atomicWriter.fenceExchangeAndRequireReconnect).toHaveBeenCalledWith({
        providerAccountId: ACCOUNT_ID,
        credentialVersion: 1,
        exchangeGeneration: 1,
        exchangeOwner: ACCOUNT_ID,
        now: 1_000,
      });
    }
  );

  it("maps retry-safe verification refresh failure without requiring reconnect", async () => {
    const store = stores();
    const providerAdapter = adapter();
    vi.mocked(providerAdapter.refresh).mockRejectedValue(
      new ProviderRefreshError("refresh failed", "retry_safe")
    );
    const service = createService(
      store,
      new ModelProviderAccountAdapterRegistry([providerAdapter]),
      { generateId: () => ACCOUNT_ID, now: () => 1_000 }
    );

    await expect(service.verify(ACCOUNT_ID, "user-1")).rejects.toMatchObject({
      status: 502,
      message: "Provider credential verification failed safely; retry the operation",
    });
    expect(store.atomicWriter.fenceExchangeAndRequireReconnect).not.toHaveBeenCalled();
  });

  it("maps an invalid stored verification credential to a stable conflict", async () => {
    const store = stores();
    const providerAdapter = adapter();
    vi.mocked(providerAdapter.parseCredential).mockImplementation(() => {
      throw new Error("secret parse detail");
    });
    const service = createService(
      store,
      new ModelProviderAccountAdapterRegistry([providerAdapter]),
      { generateId: () => ACCOUNT_ID, now: () => 1_000 }
    );

    await expect(service.verify(ACCOUNT_ID, "user-1")).rejects.toMatchObject({
      status: 409,
      message: "Stored provider credential is invalid",
    });
  });

  it("uses authoritative account state when verification terminal fencing loses its claim", async () => {
    const store = stores();
    const providerAdapter = adapter();
    vi.mocked(providerAdapter.refresh).mockRejectedValue(
      new ProviderRefreshError("refresh failed", "ambiguous")
    );
    vi.mocked(store.atomicWriter.fenceExchangeAndRequireReconnect).mockResolvedValue(false);
    vi.mocked(store.accounts.getById)
      .mockResolvedValueOnce(providerAccount())
      .mockResolvedValue(providerAccount({ status: "disabled" }));
    const service = createService(
      store,
      new ModelProviderAccountAdapterRegistry([providerAdapter]),
      { generateId: () => ACCOUNT_ID, now: () => 1_000 }
    );

    const error = await service.verify(ACCOUNT_ID, "user-1").catch((cause: unknown) => cause);

    expect(error).toMatchObject({ status: 409 });
    expect((error as Error).message).toMatch(/not active/i);
  });
});
