import { describe, expect, it, vi } from "vitest";
import type { ProviderCredentialState } from "../db/provider-account-credentials";
import {
  ModelProviderAccountAdapterRegistry,
  ProviderRefreshError,
  type ModelProviderAccountAdapter,
} from "./model-provider-account-adapters";
import {
  ClaimedProviderCredentialExchange,
  type ClaimedProviderCredentialExchangeStore,
} from "./claimed-provider-credential-exchange";

type Credential = { refreshToken: string };

const NOW = 1_000;

function state(): ProviderCredentialState<Credential> {
  return {
    payload: { refreshToken: "stored" },
    credentialSchemaVersion: 1,
    credentialVersion: 3,
    exchangeGeneration: 0,
    exchangeState: "idle",
    exchangeOwner: null,
    exchangeStartedAt: null,
    accessTokenExpiresAt: null,
    updatedAt: 1,
  };
}

function adapter(
  refresh: ModelProviderAccountAdapter<Credential, never>["refresh"] = vi.fn().mockResolvedValue({
    credential: { refreshToken: "rotated" },
    accessToken: "access",
    accessTokenExpiresAt: 4_000,
  })
): ModelProviderAccountAdapter<Credential, never> {
  return {
    provider: "openai",
    credentialSchemaVersion: 1,
    refreshBufferMs: 1,
    parseConnectInput: vi.fn() as never,
    connect: vi.fn() as never,
    parseCredential: vi.fn((value) => value as Credential),
    refresh,
    cachedAccess: vi.fn(() => null),
    validateReconnectInputIdentity: vi.fn() as never,
    runtimeMetadata: vi.fn(() => ({})),
    validateExternalIdentity: vi.fn(),
  };
}

function setup(providerAdapter = adapter()) {
  const calls: string[] = [];
  const complete = vi.fn(async () => {
    calls.push("complete");
    return true;
  });
  const store: ClaimedProviderCredentialExchangeStore = {
    tryBeginExchange: vi.fn(async () => {
      calls.push("claim");
      return { acquired: true, generation: 7 };
    }),
    clearSafeFailure: vi.fn(async () => {
      calls.push("clear");
      return true;
    }),
  };
  const terminalFailure = vi.fn(async () => {
    calls.push("terminal");
    return true;
  });
  const registry = new ModelProviderAccountAdapterRegistry([providerAdapter]);
  const exchange = new ClaimedProviderCredentialExchange(store, terminalFailure);
  return {
    calls,
    complete,
    exchange,
    providerAdapter: registry.get("openai")!,
    store,
    terminalFailure,
  };
}

describe("ClaimedProviderCredentialExchange", () => {
  it("claims before parsing and refresh, then dispatches one fenced completion", async () => {
    const { calls, complete, exchange, providerAdapter } = setup();
    vi.mocked(providerAdapter.parseCredential).mockImplementation((value) => {
      calls.push("parse");
      return value as Credential;
    });
    vi.mocked(providerAdapter.refresh).mockImplementation(async () => {
      calls.push("refresh");
      return {
        credential: { refreshToken: "rotated" },
        accessToken: "access",
        accessTokenExpiresAt: 4_000,
      };
    });

    await expect(
      exchange.run({
        providerAccountId: "account-1",
        provider: "openai",
        state: state(),
        expectedAccountStatus: "active",
        adapter: providerAdapter,
        owner: "owner-1",
        now: () => NOW,
        complete,
      })
    ).resolves.toMatchObject({ kind: "completed", refreshed: { accessToken: "access" } });

    expect(calls).toEqual(["claim", "parse", "refresh", "complete"]);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        write: expect.objectContaining({
          providerAccountId: "account-1",
          expectedCredentialVersion: 3,
          exchangeGeneration: 7,
          exchangeOwner: "owner-1",
          expectedAccountStatus: "active",
          payload: { refreshToken: "rotated" },
        }),
      })
    );
  });

  it("does not parse or refresh when the durable claim is unavailable", async () => {
    const { complete, exchange, providerAdapter, store } = setup();
    vi.mocked(store.tryBeginExchange).mockResolvedValue({ acquired: false });

    await expect(
      exchange.run({
        providerAccountId: "account-1",
        provider: "openai",
        state: state(),
        expectedAccountStatus: "active",
        adapter: providerAdapter,
        owner: "owner-1",
        now: () => NOW,
        complete,
      })
    ).resolves.toEqual({ kind: "claim_unavailable" });
    expect(providerAdapter.parseCredential).not.toHaveBeenCalled();
    expect(providerAdapter.refresh).not.toHaveBeenCalled();
  });

  it("clears the fenced claim after retry-safe refresh failure", async () => {
    const failure = new ProviderRefreshError("retry", "retry_safe");
    const { complete, exchange, providerAdapter, store, terminalFailure } = setup(
      adapter(vi.fn().mockRejectedValue(failure))
    );

    await expect(
      exchange.run({
        providerAccountId: "account-1",
        provider: "openai",
        state: state(),
        expectedAccountStatus: "active",
        adapter: providerAdapter,
        owner: "owner-1",
        now: () => NOW,
        complete,
      })
    ).rejects.toMatchObject({ phase: "refresh", cause: failure });
    expect(store.clearSafeFailure).toHaveBeenCalledWith("account-1", 3, 7, "owner-1", NOW);
    expect(terminalFailure).not.toHaveBeenCalled();
  });

  it("preserves a retry-safe refresh failure when clearing the claim also fails", async () => {
    const failure = new ProviderRefreshError("retry", "retry_safe");
    const { complete, exchange, providerAdapter, store } = setup(
      adapter(vi.fn().mockRejectedValue(failure))
    );
    vi.mocked(store.clearSafeFailure).mockRejectedValue(new Error("D1 unavailable"));

    await expect(
      exchange.run({
        providerAccountId: "account-1",
        provider: "openai",
        state: state(),
        expectedAccountStatus: "active",
        adapter: providerAdapter,
        owner: "owner-1",
        now: () => NOW,
        complete,
      })
    ).rejects.toMatchObject({ phase: "refresh", cause: failure });
  });

  it.each(["ambiguous", "unauthorized"] as const)(
    "atomically fences the claim and requires reconnect after a %s refresh failure",
    async (classification) => {
      const failure = new ProviderRefreshError(classification, classification);
      const { complete, exchange, providerAdapter, store, terminalFailure } = setup(
        adapter(vi.fn().mockRejectedValue(failure))
      );

      await expect(
        exchange.run({
          providerAccountId: "account-1",
          provider: "openai",
          state: state(),
          expectedAccountStatus: "active",
          adapter: providerAdapter,
          owner: "owner-1",
          now: () => NOW,
          complete,
        })
      ).rejects.toMatchObject({
        phase: "refresh",
        terminalFence: "committed",
      });
      expect(terminalFailure).toHaveBeenCalledWith({
        providerAccountId: "account-1",
        credentialVersion: 3,
        exchangeGeneration: 7,
        exchangeOwner: "owner-1",
        now: NOW,
      });
      expect(store.clearSafeFailure).not.toHaveBeenCalled();
    }
  );

  it("reports when terminal fencing loses the refresh claim", async () => {
    const failure = new ProviderRefreshError("ambiguous", "ambiguous");
    const { complete, exchange, providerAdapter, terminalFailure } = setup(
      adapter(vi.fn().mockRejectedValue(failure))
    );
    terminalFailure.mockResolvedValue(false);

    await expect(
      exchange.run({
        providerAccountId: "account-1",
        provider: "openai",
        state: state(),
        expectedAccountStatus: "active",
        adapter: providerAdapter,
        owner: "owner-1",
        now: () => NOW,
        complete,
      })
    ).rejects.toMatchObject({
      phase: "refresh",
      cause: failure,
      terminalFence: "lost",
    });
  });

  it("clears the claim when credential parsing fails before refresh dispatch", async () => {
    const { complete, exchange, providerAdapter, store } = setup();
    vi.mocked(providerAdapter.parseCredential).mockImplementation(() => {
      throw new Error("invalid credential");
    });

    await expect(
      exchange.run({
        providerAccountId: "account-1",
        provider: "openai",
        state: state(),
        expectedAccountStatus: "active",
        adapter: providerAdapter,
        owner: "owner-1",
        now: () => NOW,
        complete,
      })
    ).rejects.toMatchObject({ phase: "parse" });
    expect(store.clearSafeFailure).toHaveBeenCalledWith("account-1", 3, 7, "owner-1", NOW);
  });

  it("preserves a parse failure when clearing the claim also fails", async () => {
    const { complete, exchange, providerAdapter, store } = setup();
    const parseFailure = new Error("invalid credential");
    vi.mocked(providerAdapter.parseCredential).mockImplementation(() => {
      throw parseFailure;
    });
    vi.mocked(store.clearSafeFailure).mockRejectedValue(new Error("D1 unavailable"));

    await expect(
      exchange.run({
        providerAccountId: "account-1",
        provider: "openai",
        state: state(),
        expectedAccountStatus: "active",
        adapter: providerAdapter,
        owner: "owner-1",
        now: () => NOW,
        complete,
      })
    ).rejects.toMatchObject({ phase: "parse", cause: parseFailure });
  });

  it("atomically fences when the caller's completion cannot commit", async () => {
    const { exchange, providerAdapter, terminalFailure } = setup();
    const complete = vi.fn().mockResolvedValue(false);

    await expect(
      exchange.run({
        providerAccountId: "account-1",
        provider: "openai",
        state: state(),
        expectedAccountStatus: "active",
        adapter: providerAdapter,
        owner: "owner-1",
        now: () => NOW,
        complete,
      })
    ).rejects.toMatchObject({ phase: "completion" });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        write: expect.objectContaining({
          expectedCredentialVersion: 3,
          exchangeGeneration: 7,
          exchangeOwner: "owner-1",
          expectedAccountStatus: "active",
        }),
      })
    );
    expect(terminalFailure).toHaveBeenCalledWith({
      providerAccountId: "account-1",
      credentialVersion: 3,
      exchangeGeneration: 7,
      exchangeOwner: "owner-1",
      now: NOW,
    });
  });

  it("reports when terminal fencing loses a failed completion claim", async () => {
    const { exchange, providerAdapter, terminalFailure } = setup();
    terminalFailure.mockResolvedValue(false);

    await expect(
      exchange.run({
        providerAccountId: "account-1",
        provider: "openai",
        state: state(),
        expectedAccountStatus: "active",
        adapter: providerAdapter,
        owner: "owner-1",
        now: () => NOW,
        complete: vi.fn().mockResolvedValue(false),
      })
    ).rejects.toMatchObject({ phase: "completion", terminalFence: "lost" });
  });

  it("preserves a failed completion when terminal fencing also fails", async () => {
    const { exchange, providerAdapter, terminalFailure } = setup();
    terminalFailure.mockRejectedValue(new Error("D1 unavailable"));

    await expect(
      exchange.run({
        providerAccountId: "account-1",
        provider: "openai",
        state: state(),
        expectedAccountStatus: "active",
        adapter: providerAdapter,
        owner: "owner-1",
        now: () => NOW,
        complete: vi.fn().mockResolvedValue(false),
      })
    ).rejects.toMatchObject({ phase: "completion", terminalFence: "lost" });
  });
});
