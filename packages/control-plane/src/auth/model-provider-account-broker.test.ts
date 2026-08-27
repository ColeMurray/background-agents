import { describe, expect, it, vi } from "vitest";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import type { ProviderCredentialState } from "../db/provider-account-credentials";
import {
  ModelProviderAccountAdapterRegistry,
  ProviderIdentityError,
  ProviderRefreshError,
  type ModelProviderAccountAdapter,
} from "./model-provider-account-adapters";
import {
  ModelProviderAccountBroker,
  ModelProviderAccountBrokerError,
  type ModelProviderAccountBrokerStores,
} from "./model-provider-account-broker";

type Credential = {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
};

const NOW = 1_000_000;

function account(overrides: Partial<ModelProviderAccount> = {}): ModelProviderAccount {
  return {
    id: "account-1",
    provider: "openai",
    displayName: "Primary",
    externalAccountId: "external-1",
    status: "active",
    createdBy: null,
    updatedBy: null,
    lastVerifiedAt: null,
    lastUsedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

function state(
  overrides: Partial<ProviderCredentialState<Credential>> = {}
): ProviderCredentialState<Credential> {
  return {
    payload: { refreshToken: "refresh" },
    credentialSchemaVersion: 1,
    credentialVersion: 1,
    exchangeGeneration: 0,
    exchangeState: "idle",
    exchangeOwner: null,
    exchangeStartedAt: null,
    accessTokenExpiresAt: null,
    updatedAt: 1,
    ...overrides,
  };
}

function adapter(
  refresh: ModelProviderAccountAdapter<Credential, never>["refresh"] = vi.fn()
): ModelProviderAccountAdapter<Credential, never> {
  return {
    provider: "openai",
    credentialSchemaVersion: 1,
    refreshBufferMs: 300_000,
    parseConnectInput: vi.fn() as never,
    connect: vi.fn() as never,
    parseCredential: (value, version) => {
      if (version !== 1 || !value || typeof value !== "object" || !("refreshToken" in value)) {
        throw new Error("invalid credential");
      }
      return value as Credential;
    },
    refresh,
    cachedAccess: (credential) =>
      credential.accessToken && credential.accessTokenExpiresAt
        ? {
            accessToken: credential.accessToken,
            accessTokenExpiresAt: credential.accessTokenExpiresAt,
          }
        : null,
    validateReconnectInputIdentity: vi.fn() as never,
    runtimeMetadata: (_credential, externalAccountId): Record<string, string> =>
      externalAccountId ? { accountId: externalAccountId } : {},
    validateExternalIdentity: (actual, expected) => {
      if (!actual || !expected || actual !== expected) {
        throw new ProviderIdentityError("OpenAI account identity did not match");
      }
    },
  };
}

function setup(
  options: {
    providerAccount?: ModelProviderAccount | null;
    credentialStates?: Array<ProviderCredentialState<Credential> | null>;
    refresh?: ModelProviderAccountAdapter<Credential, never>["refresh"];
    tryBegin?: ModelProviderAccountBrokerStores["credentials"]["tryBeginExchange"];
    complete?: ModelProviderAccountBrokerStores["credentials"]["completeExchange"];
    terminalFailure?: ModelProviderAccountBrokerStores["atomicWriter"]["fenceExchangeAndRequireReconnect"];
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    useDefaultPolling?: boolean;
    exchangeTimeoutMs?: number;
    pollDelayMs?: number;
  } = {}
) {
  const states = [...(options.credentialStates ?? [state()])];
  let lastState = states.at(-1) ?? null;
  const stores: ModelProviderAccountBrokerStores = {
    accounts: {
      getById: vi
        .fn()
        .mockResolvedValue(
          options.providerAccount === undefined ? account() : options.providerAccount
        ),
      touchLastUsed: vi.fn().mockResolvedValue(true),
    },
    credentials: {
      readCredentialState: vi.fn().mockImplementation(async () => {
        if (states.length) lastState = states.shift() ?? null;
        return lastState;
      }),
      tryBeginExchange:
        options.tryBegin ?? vi.fn().mockResolvedValue({ acquired: true, generation: 1 }),
      completeExchange: options.complete ?? vi.fn().mockResolvedValue(true),
      clearSafeFailure: vi.fn().mockResolvedValue(true),
    },
    atomicWriter: {
      fenceExchangeAndRequireReconnect: options.terminalFailure ?? vi.fn().mockResolvedValue(true),
    },
  };
  const refresh =
    options.refresh ??
    vi.fn().mockResolvedValue({
      credential: {
        refreshToken: "replacement",
        accessToken: "new-access",
        accessTokenExpiresAt: NOW + 3_600_000,
      },
      accessToken: "new-access",
      accessTokenExpiresAt: NOW + 3_600_000,
      externalAccountId: "external-1",
    });
  const registry = new ModelProviderAccountAdapterRegistry([adapter(refresh)]);
  const broker = new ModelProviderAccountBroker(stores, registry, {
    now: options.now ?? (() => NOW),
    sleep: options.sleep ?? (() => Promise.resolve()),
    createOwner: () => "owner-1",
    ...(options.useDefaultPolling ? {} : { maxPollAttempts: 3 }),
    exchangeTimeoutMs: options.exchangeTimeoutMs ?? 10_000,
    pollDelayMs: options.pollDelayMs,
  });
  return { broker, stores, refresh };
}

describe("ModelProviderAccountBroker", () => {
  it("reuses a valid cached access token", async () => {
    const { broker, stores, refresh } = setup({
      credentialStates: [
        state({
          payload: {
            refreshToken: "refresh",
            accessToken: "cached",
            accessTokenExpiresAt: NOW + 600_000,
          },
          accessTokenExpiresAt: NOW + 600_000,
        }),
      ],
    });

    await expect(broker.getAccess("account-1", "openai")).resolves.toMatchObject({
      accessToken: "cached",
      providerMetadata: { accountId: "external-1" },
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(stores.credentials.tryBeginExchange).not.toHaveBeenCalled();
  });

  it("coalesces refreshes for the same account and credential version locally", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const refresh = vi.fn().mockImplementation(async () => {
      await gate;
      return {
        credential: {
          refreshToken: "next",
          accessToken: "access",
          accessTokenExpiresAt: NOW + 600_000,
        },
        accessToken: "access",
        accessTokenExpiresAt: NOW + 600_000,
        externalAccountId: "external-1",
      };
    });
    const { broker, stores } = setup({ refresh, credentialStates: [state(), state()] });

    const first = broker.getAccess("account-1", "openai");
    const second = broker.getAccess("account-1", "openai");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(stores.credentials.tryBeginExchange).toHaveBeenCalledTimes(1);
  });

  it("polls when another process owns the durable claim and returns its token", async () => {
    const winner = state({
      payload: { refreshToken: "next", accessToken: "winner", accessTokenExpiresAt: NOW + 600_000 },
      credentialVersion: 2,
      accessTokenExpiresAt: NOW + 600_000,
    });
    const { broker, refresh, stores } = setup({
      credentialStates: [state(), winner],
      tryBegin: vi.fn().mockResolvedValue({ acquired: false }),
    });

    await expect(broker.getAccess("account-1", "openai")).resolves.toMatchObject({
      accessToken: "winner",
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(stores.credentials.readCredentialState).toHaveBeenCalledTimes(2);
  });

  it("waits for a cross-isolate exchange through its claim deadline", async () => {
    const inFlight = state({
      exchangeState: "in_flight",
      exchangeGeneration: 1,
      exchangeOwner: "other-isolate",
      exchangeStartedAt: NOW,
    });
    const winner = state({
      payload: { refreshToken: "next", accessToken: "winner", accessTokenExpiresAt: NOW + 600_000 },
      credentialVersion: 2,
      exchangeGeneration: 1,
      accessTokenExpiresAt: NOW + 600_000,
    });
    const { broker, stores } = setup({
      credentialStates: [inFlight, inFlight, inFlight, inFlight, inFlight, inFlight, winner],
      useDefaultPolling: true,
      exchangeTimeoutMs: 1_000,
      pollDelayMs: 100,
    });

    await expect(broker.getAccess("account-1", "openai")).resolves.toMatchObject({
      accessToken: "winner",
    });
    expect(stores.credentials.readCredentialState).toHaveBeenCalledTimes(7);
  });

  it("fences a stale exchange before marking reconnect required", async () => {
    const calls: string[] = [];
    const terminalFailure = vi.fn().mockImplementation(async () => {
      calls.push("terminal");
      return true;
    });
    const { broker } = setup({
      credentialStates: [
        state({
          exchangeState: "in_flight",
          exchangeGeneration: 4,
          exchangeOwner: "dead-owner",
          exchangeStartedAt: NOW - 20_000,
        }),
      ],
      terminalFailure,
    });

    await expect(broker.getAccess("account-1", "openai")).rejects.toMatchObject({
      code: "reconnect_required",
    });
    expect(terminalFailure).toHaveBeenCalledWith({
      providerAccountId: "account-1",
      credentialVersion: 1,
      exchangeGeneration: 4,
      exchangeOwner: "dead-owner",
      now: NOW,
    });
    expect(calls).toEqual(["terminal"]);
  });

  it("uses a late completion when stale fencing loses the race", async () => {
    const stale = state({
      exchangeState: "in_flight",
      exchangeGeneration: 4,
      exchangeOwner: "slow-owner",
      exchangeStartedAt: NOW - 20_000,
    });
    const completed = state({
      payload: { refreshToken: "next", accessToken: "late", accessTokenExpiresAt: NOW + 600_000 },
      credentialVersion: 2,
      exchangeGeneration: 4,
      accessTokenExpiresAt: NOW + 600_000,
    });
    const { broker, refresh } = setup({
      credentialStates: [stale, completed],
      terminalFailure: vi.fn().mockResolvedValue(false),
    });

    await expect(broker.getAccess("account-1", "openai")).resolves.toMatchObject({
      accessToken: "late",
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reconciles durable state when stale fencing rejects ambiguously", async () => {
    const stale = state({
      exchangeState: "in_flight",
      exchangeGeneration: 4,
      exchangeOwner: "slow-owner",
      exchangeStartedAt: NOW - 20_000,
    });
    const completed = state({
      payload: { refreshToken: "next", accessToken: "late", accessTokenExpiresAt: NOW + 600_000 },
      credentialVersion: 2,
      exchangeGeneration: 4,
      accessTokenExpiresAt: NOW + 600_000,
    });
    const { broker, refresh } = setup({
      credentialStates: [stale, completed],
      terminalFailure: vi.fn().mockRejectedValue(new Error("D1 response lost")),
    });

    await expect(broker.getAccess("account-1", "openai")).resolves.toMatchObject({
      accessToken: "late",
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("preserves a stale-fence storage error when durable state is unchanged", async () => {
    const stale = state({
      exchangeState: "in_flight",
      exchangeGeneration: 4,
      exchangeOwner: "slow-owner",
      exchangeStartedAt: NOW - 20_000,
    });
    const failure = new Error("D1 response lost");
    const { broker, refresh } = setup({
      credentialStates: [stale, stale],
      terminalFailure: vi.fn().mockRejectedValue(failure),
    });

    await expect(broker.getAccess("account-1", "openai")).rejects.toBe(failure);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("observes reconnect state when another caller wins stale fencing", async () => {
    const stale = state({
      exchangeState: "in_flight",
      exchangeGeneration: 4,
      exchangeOwner: "slow-owner",
      exchangeStartedAt: NOW - 20_000,
    });
    const { broker, stores, refresh } = setup({
      credentialStates: [stale],
      terminalFailure: vi.fn().mockResolvedValue(false),
    });
    vi.mocked(stores.accounts.getById)
      .mockResolvedValueOnce(account())
      .mockResolvedValue(account({ status: "reconnect_required" }));

    await expect(broker.getAccess("account-1", "openai")).rejects.toMatchObject({
      code: "reconnect_required",
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["unauthorized", "ambiguous"] as const)(
    "marks %s refresh failures reconnect required",
    async (classification) => {
      const terminalFailure = vi.fn().mockResolvedValue(true);
      const { broker } = setup({
        refresh: vi.fn().mockRejectedValue(new ProviderRefreshError("failed", classification)),
        terminalFailure,
      });

      await expect(broker.getAccess("account-1", "openai")).rejects.toMatchObject({
        code: "reconnect_required",
      });
      expect(terminalFailure).toHaveBeenCalledWith(
        expect.objectContaining({ providerAccountId: "account-1", credentialVersion: 1 })
      );
    }
  );

  it("uses the authoritative lifecycle when terminal fencing loses its claim", async () => {
    const { broker, stores } = setup({
      refresh: vi.fn().mockRejectedValue(new ProviderRefreshError("failed", "ambiguous")),
      terminalFailure: vi.fn().mockResolvedValue(false),
    });
    vi.mocked(stores.accounts.getById)
      .mockResolvedValueOnce(account())
      .mockResolvedValue(account({ status: "disabled" }));

    await expect(broker.getAccess("account-1", "openai")).rejects.toMatchObject({
      code: "account_inactive",
    });
    expect(stores.credentials.readCredentialState).toHaveBeenCalledTimes(1);
  });

  it("uses a concurrent credential replacement when terminal fencing loses its claim", async () => {
    const completed = state({
      payload: {
        refreshToken: "next",
        accessToken: "winner",
        accessTokenExpiresAt: NOW + 600_000,
      },
      credentialVersion: 2,
      accessTokenExpiresAt: NOW + 600_000,
    });
    const { broker } = setup({
      credentialStates: [state(), completed],
      refresh: vi.fn().mockRejectedValue(new ProviderRefreshError("failed", "ambiguous")),
      terminalFailure: vi.fn().mockResolvedValue(false),
    });

    await expect(broker.getAccess("account-1", "openai")).resolves.toMatchObject({
      accessToken: "winner",
    });
  });

  it("does not claim reconnect when terminal fencing loses an unchanged claim", async () => {
    const { broker } = setup({
      credentialStates: [state(), state()],
      refresh: vi.fn().mockRejectedValue(new ProviderRefreshError("failed", "ambiguous")),
      terminalFailure: vi.fn().mockResolvedValue(false),
    });

    await expect(broker.getAccess("account-1", "openai")).rejects.toMatchObject({
      code: "exchange_busy",
    });
  });

  it.each([undefined, "different-account"])(
    "rejects refreshed OpenAI identity %s before persisting rotated credentials",
    async (externalAccountId) => {
      const terminalFailure = vi.fn().mockResolvedValue(true);
      const { broker, stores } = setup({
        refresh: vi.fn().mockResolvedValue({
          credential: {
            refreshToken: "replacement",
            accessToken: "new-access",
            accessTokenExpiresAt: NOW + 3_600_000,
          },
          accessToken: "new-access",
          accessTokenExpiresAt: NOW + 3_600_000,
          externalAccountId,
        }),
        terminalFailure,
      });

      await expect(broker.getAccess("account-1", "openai")).rejects.toMatchObject({
        code: "reconnect_required",
      });
      expect(stores.credentials.completeExchange).not.toHaveBeenCalled();
      expect(terminalFailure).toHaveBeenCalledTimes(1);
    }
  );

  it("never returns a token when completion persistence fails", async () => {
    const terminalFailure = vi.fn().mockResolvedValue(true);
    const { broker } = setup({
      complete: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
      terminalFailure,
    });

    await expect(broker.getAccess("account-1", "openai")).rejects.toMatchObject({
      code: "reconnect_required",
    });
    expect(terminalFailure).toHaveBeenCalled();
  });

  it.each([
    [account({ status: "disabled" }), "account_inactive"],
    [account({ status: "reconnect_required" }), "account_inactive"],
    [account({ archivedAt: NOW }), "account_archived"],
    [account({ provider: "xai" }), "provider_mismatch"],
  ] as const)(
    "rejects inactive, archived, and mismatched accounts",
    async (providerAccount, code) => {
      const { broker, stores } = setup({ providerAccount });

      await expect(broker.getAccess("account-1", "openai")).rejects.toMatchObject({ code });
      expect(stores.credentials.readCredentialState).not.toHaveBeenCalled();
    }
  );

  it("does not fall back to a different account", async () => {
    const { broker, stores } = setup({ providerAccount: null });

    await expect(broker.getAccess("missing", "openai")).rejects.toBeInstanceOf(
      ModelProviderAccountBrokerError
    );
    expect(stores.accounts.getById).toHaveBeenCalledTimes(1);
    expect(stores.credentials.readCredentialState).not.toHaveBeenCalled();
  });
});
