import { describe, expect, it, vi } from "vitest";
import {
  ModelProviderAccountAdapterRegistry,
  ProviderAuthorizationCodeExchangeError,
  type ProviderAuthorizationCodeCapability,
} from "../auth/model-provider-account-adapters";
import {
  AnthropicModelProviderAccountAdapter,
  type AnthropicProviderCredential,
} from "../auth/model-provider-account-anthropic-adapter";
import { OpenAIModelProviderAccountAdapter } from "../auth/model-provider-account-openai-adapter";
import {
  decryptProviderAuthorizationPayload,
  encryptProviderAuthorizationPayload,
} from "../auth/provider-account-crypto";
import type {
  ConnectedProviderAuthorization,
  PendingProviderAuthorization,
  ProcessingProviderAuthorization,
  ProviderAccountAuthorizationStore,
  ProviderAuthorization,
  ProviderAuthorizationTerminalState,
  TerminalProviderAuthorization,
} from "../db/provider-account-authorizations";
import { ProviderAuthorizationCodeService } from "./authorization-code-service";
import { PROVIDER_AUTHORIZATION_PROCESSING_CLAIM_TIMEOUT_MS } from "./authorization-transaction";

const TRANSACTION_ID = "01".repeat(32);
const USER_ID = "user-1";
const ENCRYPTION_KEY = btoa("x".repeat(32));
const PROVIDER_STATE = { codeVerifier: "verifier", state: "state-1" };
const CREDENTIAL: AnthropicProviderCredential = {
  kind: "setup_token",
  token: "sk-ant-oat01-secret",
  expiresAt: 900_000,
  scopes: ["user:inference"],
};
type CreatePendingProviderAuthorization = Extract<
  PendingProviderAuthorization,
  { operation: "create" }
>;

function encryptState(providerState: unknown, exchangeAttempts: number): Promise<string> {
  return encryptProviderAuthorizationPayload({ providerState, exchangeAttempts }, ENCRYPTION_KEY, {
    transactionId: TRANSACTION_ID,
    provider: "anthropic",
    stateSchemaVersion: 1,
  });
}

function pending(
  overrides: Partial<CreatePendingProviderAuthorization> = {}
): CreatePendingProviderAuthorization {
  return {
    id: TRANSACTION_ID,
    userId: USER_ID,
    provider: "anthropic",
    authorizationKind: "authorization_code",
    operation: "create",
    displayName: "Claude",
    encryptedProviderData: "encrypted",
    providerStateVersion: 1,
    intervalMs: 1_000,
    nextPollAt: 10_000,
    expiresAt: 100_000,
    state: "pending",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function connected(completedAt: number): ConnectedProviderAuthorization {
  return {
    id: TRANSACTION_ID,
    userId: USER_ID,
    provider: "anthropic",
    authorizationKind: "authorization_code",
    operation: "create",
    displayName: "Claude",
    intervalMs: 1_000,
    nextPollAt: 10_000,
    expiresAt: 100_000,
    state: "connected",
    resultProviderAccountId: "account-1",
    reconnectedExisting: false,
    createdAt: 1,
    updatedAt: completedAt,
    completedAt,
  };
}

function terminal(
  authorization: ProviderAuthorization,
  state: ProviderAuthorizationTerminalState,
  completedAt: number
): TerminalProviderAuthorization {
  const common = {
    id: authorization.id,
    userId: authorization.userId,
    provider: authorization.provider,
    authorizationKind: authorization.authorizationKind,
    intervalMs: authorization.intervalMs,
    nextPollAt: authorization.nextPollAt,
    expiresAt: authorization.expiresAt,
    createdAt: authorization.createdAt,
    updatedAt: completedAt,
    completedAt,
    state,
  };
  return authorization.operation === "create"
    ? { ...common, operation: "create", displayName: authorization.displayName }
    : {
        ...common,
        operation: "reconnect",
        providerAccountId: authorization.providerAccountId,
        targetAccountStatus: authorization.targetAccountStatus,
        targetAccountLifecycleVersion: authorization.targetAccountLifecycleVersion,
      };
}

function capability(
  complete: ProviderAuthorizationCodeCapability<AnthropicProviderCredential, unknown>["complete"]
) {
  return {
    stateSchemaVersion: 1,
    start: vi.fn(async () => ({
      providerState: PROVIDER_STATE,
      authorizationUrl: "https://claude.ai/oauth/authorize?code=true",
    })),
    parseState: vi.fn((payload: unknown) => payload),
    complete: vi.fn(complete),
  };
}

function registry(
  authorizationCode?: ProviderAuthorizationCodeCapability<AnthropicProviderCredential, unknown>
) {
  return new ModelProviderAccountAdapterRegistry([
    new AnthropicModelProviderAccountAdapter(authorizationCode),
  ]);
}

function service(
  now: number,
  transaction: ProviderAuthorization,
  adapters: ModelProviderAccountAdapterRegistry
) {
  let current = transaction;
  const transactions = {
    recordAttempt: vi.fn(async () => true),
    reserve: vi.fn(async () => true),
    activate: vi.fn<ProviderAccountAuthorizationStore["activate"]>(async () => true),
    getOwned: vi.fn(async () => current),
    finish: vi.fn(
      async (
        _id: string,
        _userId: string,
        state: ProviderAuthorizationTerminalState,
        completedAt: number
      ) => {
        current = terminal(current, state, completedAt);
        return true;
      }
    ),
    expire: vi.fn(async (authorization: ProviderAuthorization, completedAt: number) => {
      current = terminal(authorization, "expired", completedAt);
      return true;
    }),
    claim: vi.fn(async (_id: string, _userId: string, owner: string, claimedAt: number) => {
      if (current.state !== "pending") return null;
      current = {
        ...current,
        state: "processing",
        processingOwner: owner,
        processingStartedAt: claimedAt,
      };
      return current;
    }),
    returnPending: vi.fn(
      async (
        authorization: ProcessingProviderAuthorization,
        nextPollAt: number,
        intervalMs: number,
        _now: number,
        encryptedProviderData?: string
      ) => {
        if (current.state !== "processing") return false;
        current = {
          ...authorization,
          state: "pending",
          nextPollAt,
          intervalMs,
          encryptedProviderData: encryptedProviderData ?? authorization.encryptedProviderData,
        };
        return true;
      }
    ),
  };
  const account = {
    id: "account-1",
    provider: "anthropic" as const,
    displayName: "Claude",
    externalAccountId: null,
    status: "active" as const,
    createdBy: USER_ID,
    updatedBy: USER_ID,
    lastVerifiedAt: now,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  const finalizer = {
    finalizeTrustedConnection: vi.fn(async () => {
      current = connected(now);
      return true;
    }),
  };
  const logger = { error: vi.fn() };
  const subject = new ProviderAuthorizationCodeService(
    transactions,
    { getLifecycleSnapshot: vi.fn(async () => null), getById: vi.fn(async () => account) },
    finalizer,
    ENCRYPTION_KEY,
    adapters,
    { generateId: (bytes) => "ab".repeat(bytes), now: () => now },
    logger
  );
  return {
    subject,
    transactions,
    finalizer,
    logger,
    account,
    current: () => current,
    setCurrent: (next: ProviderAuthorization) => (current = next),
  };
}

describe("ProviderAuthorizationCodeService start", () => {
  it("reserves an authorization-code transaction that can be completed immediately", async () => {
    const authorizationCode = capability(async () => ({ credential: CREDENTIAL }));
    const { subject, transactions } = service(10_000, pending(), registry(authorizationCode));

    const started = await subject.start(USER_ID, "anthropic", {
      operation: "create",
      displayName: "Claude",
    });

    expect(started).toEqual({
      transactionId: "ab".repeat(32),
      provider: "anthropic",
      operation: "create",
      authorizationUrl: "https://claude.ai/oauth/authorize?code=true",
      expiresAt: 610_000,
      expiresInMs: 600_000,
    });
    expect(transactions.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationKind: "authorization_code", provider: "anthropic" })
    );
    expect(transactions.activate).toHaveBeenCalledWith(
      "ab".repeat(32),
      USER_ID,
      expect.any(String),
      1,
      1_000,
      610_000,
      10_000,
      10_000
    );
    const encrypted = transactions.activate.mock.calls[0][2];
    await expect(
      decryptProviderAuthorizationPayload(encrypted, ENCRYPTION_KEY, {
        transactionId: "ab".repeat(32),
        provider: "anthropic",
        stateSchemaVersion: 1,
      })
    ).resolves.toEqual({ providerState: PROVIDER_STATE, exchangeAttempts: 0 });
  });

  it("refuses providers without an authorization-code capability", async () => {
    const { subject, transactions } = service(
      10_000,
      pending(),
      new ModelProviderAccountAdapterRegistry([new OpenAIModelProviderAccountAdapter()])
    );

    await expect(
      subject.start(USER_ID, "openai", { operation: "create", displayName: "OpenAI" })
    ).rejects.toMatchObject({ status: 409 });
    expect(transactions.reserve).not.toHaveBeenCalled();
  });

  it("fails the reservation when the provider cannot start", async () => {
    const authorizationCode = capability(async () => ({ credential: CREDENTIAL }));
    authorizationCode.start.mockRejectedValueOnce(new Error("crypto unavailable"));
    const { subject, transactions } = service(10_000, pending(), registry(authorizationCode));

    await expect(
      subject.start(USER_ID, "anthropic", { operation: "create", displayName: "Claude" })
    ).rejects.toMatchObject({ status: 502, retryable: true });
    expect(transactions.finish).toHaveBeenCalledWith("ab".repeat(32), USER_ID, "failed", 10_000);
  });
});

describe("ProviderAuthorizationCodeService status", () => {
  it("reports a pending transaction without contacting the provider", async () => {
    const authorizationCode = capability(async () => ({ credential: CREDENTIAL }));
    const { subject } = service(10_000, pending(), registry(authorizationCode));

    await expect(subject.status(USER_ID, "anthropic", TRANSACTION_ID)).resolves.toEqual({
      status: "pending",
      expiresAt: 100_000,
    });
    expect(authorizationCode.complete).not.toHaveBeenCalled();
  });

  it("durably expires a lapsed transaction", async () => {
    const { subject, transactions } = service(100_000, pending(), registry());

    await expect(subject.status(USER_ID, "anthropic", TRANSACTION_ID)).resolves.toMatchObject({
      status: "expired",
      retryable: true,
    });
    expect(transactions.expire).toHaveBeenCalledOnce();
  });

  it("fails a stale processing claim closed", async () => {
    const staleAt = 1_000 + PROVIDER_AUTHORIZATION_PROCESSING_CLAIM_TIMEOUT_MS;
    const { subject, transactions } = service(
      staleAt,
      {
        ...pending({ expiresAt: staleAt + 1 }),
        state: "processing",
        processingOwner: "dead",
        processingStartedAt: 1_000,
      },
      registry()
    );

    await expect(subject.status(USER_ID, "anthropic", TRANSACTION_ID)).resolves.toMatchObject({
      status: "failed",
    });
    expect(transactions.finish).toHaveBeenCalledWith(
      TRANSACTION_ID,
      USER_ID,
      "failed",
      staleAt,
      "dead"
    );
  });

  it("reports a device-kind transaction of the same provider as missing", async () => {
    const { subject, transactions } = service(
      10_000,
      pending({ authorizationKind: "device" }),
      registry()
    );

    await expect(subject.status(USER_ID, "anthropic", TRANSACTION_ID)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")
    ).rejects.toMatchObject({ status: 404 });
    await expect(subject.cancel(USER_ID, "anthropic", TRANSACTION_ID)).rejects.toMatchObject({
      status: 404,
    });
    expect(transactions.claim).not.toHaveBeenCalled();
    expect(transactions.finish).not.toHaveBeenCalled();
  });

  it("does not reveal whether another provider owns a transaction ID", async () => {
    const { subject } = service(10_000, pending({ provider: "xai" }), registry());
    await expect(subject.status(USER_ID, "anthropic", TRANSACTION_ID)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("ProviderAuthorizationCodeService complete", () => {
  async function pendingWithState(exchangeAttempts = 0) {
    return pending({ encryptedProviderData: await encryptState(PROVIDER_STATE, exchangeAttempts) });
  }

  it("exchanges the pasted code once and finalizes the connection", async () => {
    const authorizationCode = capability(async () => ({
      credential: CREDENTIAL,
      accessTokenExpiresAt: CREDENTIAL.expiresAt,
    }));
    const { subject, finalizer, account } = service(
      10_000,
      await pendingWithState(),
      registry(authorizationCode)
    );

    const result = await subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code#state-1");

    expect(result).toEqual({
      status: "connected",
      account,
      reconnectedExisting: false,
      completedAt: 10_000,
    });
    expect(authorizationCode.complete).toHaveBeenCalledWith(PROVIDER_STATE, "code#state-1");
    expect(finalizer.finalizeTrustedConnection).toHaveBeenCalledWith(
      expect.objectContaining({ state: "processing", processingOwner: "ab".repeat(32) }),
      { credential: CREDENTIAL, accessTokenExpiresAt: CREDENTIAL.expiresAt },
      expect.any(AnthropicModelProviderAccountAdapter),
      10_000
    );

    const replay = await subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code#state-1");
    expect(replay).toEqual(result);
    expect(authorizationCode.complete).toHaveBeenCalledOnce();
  });

  it("denies a code the provider rejects and never exchanges it again", async () => {
    const authorizationCode = capability(async () => {
      throw new ProviderAuthorizationCodeExchangeError(
        "The pasted code belongs to a different authorization attempt",
        "rejected"
      );
    });
    const { subject, transactions, finalizer } = service(
      10_000,
      await pendingWithState(),
      registry(authorizationCode)
    );

    await expect(
      subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code#other")
    ).resolves.toEqual({
      status: "denied",
      error: "The pasted code belongs to a different authorization attempt",
      retryable: false,
    });
    expect(transactions.finish).toHaveBeenCalledWith(
      TRANSACTION_ID,
      USER_ID,
      "denied",
      10_000,
      "ab".repeat(32)
    );
    expect(finalizer.finalizeTrustedConnection).not.toHaveBeenCalled();

    await expect(
      subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code#state-1")
    ).resolves.toMatchObject({ status: "denied", retryable: false });
    expect(authorizationCode.complete).toHaveBeenCalledOnce();
  });

  it("fails an ambiguous exchange closed so the possibly consumed code is never reused", async () => {
    const authorizationCode = capability(async () => {
      throw new ProviderAuthorizationCodeExchangeError("unreachable", "ambiguous");
    });
    const { subject, transactions, logger } = service(
      10_000,
      await pendingWithState(),
      registry(authorizationCode)
    );

    await expect(subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")).resolves.toEqual({
      status: "failed",
      error: expect.stringMatching(/may already have been used.*fresh authorization/),
      retryable: true,
    });
    expect(transactions.returnPending).not.toHaveBeenCalled();
    expect(transactions.finish).toHaveBeenCalledWith(
      TRANSACTION_ID,
      USER_ID,
      "failed",
      10_000,
      "ab".repeat(32)
    );
    expect(logger.error).toHaveBeenCalledWith(
      "provider_authorization_code.exchange_ambiguous",
      expect.objectContaining({ transaction_id: TRANSACTION_ID })
    );

    await expect(
      subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")
    ).resolves.toMatchObject({ status: "failed" });
    expect(authorizationCode.complete).toHaveBeenCalledOnce();
  });

  it("returns the transaction to pending after a throttled exchange until attempts run out", async () => {
    const authorizationCode = capability(async () => {
      throw new ProviderAuthorizationCodeExchangeError("slow down", "retry_safe");
    });
    const { subject, transactions, current } = service(
      10_000,
      await pendingWithState(),
      registry(authorizationCode)
    );

    for (const attempt of [1, 2]) {
      await expect(
        subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")
      ).rejects.toMatchObject({ status: 503, retryable: true });
      const row = current();
      expect(row.state).toBe("pending");
      if (row.state !== "pending") throw new Error("unreachable");
      await expect(
        decryptProviderAuthorizationPayload(row.encryptedProviderData, ENCRYPTION_KEY, {
          transactionId: TRANSACTION_ID,
          provider: "anthropic",
          stateSchemaVersion: 1,
        })
      ).resolves.toEqual({ providerState: PROVIDER_STATE, exchangeAttempts: attempt });
    }
    expect(transactions.returnPending).toHaveBeenCalledTimes(2);

    await expect(
      subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")
    ).resolves.toMatchObject({ status: "failed", retryable: true });
    expect(authorizationCode.complete).toHaveBeenCalledTimes(3);
    expect(transactions.finish).toHaveBeenCalledWith(
      TRANSACTION_ID,
      USER_ID,
      "failed",
      10_000,
      "ab".repeat(32)
    );
  });

  it("fails closed on exchange failures that carry no classification", async () => {
    const authorizationCode = capability(async () => {
      throw new TypeError("adapter bug");
    });
    const { subject, current, logger } = service(
      10_000,
      await pendingWithState(),
      registry(authorizationCode)
    );

    await expect(
      subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")
    ).resolves.toMatchObject({ status: "failed" });
    expect(current().state).toBe("failed");
    expect(logger.error).toHaveBeenCalledWith(
      "provider_authorization_code.complete_failed",
      expect.anything()
    );
  });

  it("fails closed and logs when the persisted state cannot be used", async () => {
    const authorizationCode = capability(async () => ({ credential: CREDENTIAL }));
    const { subject, logger } = service(10_000, pending(), registry(authorizationCode));

    await expect(
      subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")
    ).resolves.toMatchObject({ status: "failed", retryable: true });
    expect(authorizationCode.complete).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "provider_authorization_code.complete_failed",
      expect.objectContaining({ transaction_id: TRANSACTION_ID, provider: "anthropic" })
    );
  });

  it.each([
    { payload: null },
    { payload: [] },
    { payload: { providerState: PROVIDER_STATE } },
    { payload: { exchangeAttempts: 0 } },
    { payload: { providerState: PROVIDER_STATE, exchangeAttempts: "0" } },
    { payload: { providerState: PROVIDER_STATE, exchangeAttempts: -1 } },
    { payload: { providerState: PROVIDER_STATE, exchangeAttempts: 0.5 } },
    { payload: { providerState: PROVIDER_STATE, exchangeAttempts: 3 } },
  ])(
    "fails closed before exchange for a malformed persisted envelope: $payload",
    async ({ payload }) => {
      const authorizationCode = capability(async () => ({ credential: CREDENTIAL }));
      const encryptedProviderData = await encryptProviderAuthorizationPayload(
        payload,
        ENCRYPTION_KEY,
        { transactionId: TRANSACTION_ID, provider: "anthropic", stateSchemaVersion: 1 }
      );
      const { subject, transactions, current, finalizer } = service(
        10_000,
        pending({ encryptedProviderData }),
        registry(authorizationCode)
      );

      await expect(
        subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")
      ).resolves.toMatchObject({ status: "failed", retryable: true });
      expect(current().state).toBe("failed");
      expect(authorizationCode.parseState).not.toHaveBeenCalled();
      expect(authorizationCode.complete).not.toHaveBeenCalled();
      expect(transactions.returnPending).not.toHaveBeenCalled();
      expect(finalizer.finalizeTrustedConnection).not.toHaveBeenCalled();
    }
  );

  it("fails closed when finalization does not connect", async () => {
    const authorizationCode = capability(async () => ({ credential: CREDENTIAL }));
    const { subject, finalizer } = service(
      10_000,
      await pendingWithState(),
      registry(authorizationCode)
    );
    finalizer.finalizeTrustedConnection.mockResolvedValueOnce(false);

    await expect(
      subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("replays terminal and connected outcomes without exchanging", async () => {
    const authorizationCode = capability(async () => ({ credential: CREDENTIAL }));
    const { subject, account } = service(10_000, connected(5_000), registry(authorizationCode));

    await expect(subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")).resolves.toEqual({
      status: "connected",
      account,
      reconnectedExisting: false,
      completedAt: 5_000,
    });
    expect(authorizationCode.complete).not.toHaveBeenCalled();
  });

  it("refuses to complete while another request holds the claim", async () => {
    const authorizationCode = capability(async () => ({ credential: CREDENTIAL }));
    const { subject } = service(
      12_000,
      { ...pending(), state: "processing", processingOwner: "other", processingStartedAt: 10_000 },
      registry(authorizationCode)
    );

    await expect(
      subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")
    ).rejects.toMatchObject({ status: 409, retryable: true });
    expect(authorizationCode.complete).not.toHaveBeenCalled();
  });

  it("returns the durable winner when the claim is lost", async () => {
    const authorizationCode = capability(async () => ({ credential: CREDENTIAL }));
    const { subject, transactions, setCurrent } = service(
      10_000,
      await pendingWithState(),
      registry(authorizationCode)
    );
    transactions.claim.mockImplementationOnce(async () => {
      setCurrent(terminal(pending(), "cancelled", 10_000));
      return null;
    });

    await expect(
      subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("expires instead of exchanging once the lifetime has lapsed", async () => {
    const authorizationCode = capability(async () => ({ credential: CREDENTIAL }));
    const { subject } = service(100_000, await pendingWithState(), registry(authorizationCode));

    await expect(
      subject.complete(USER_ID, "anthropic", TRANSACTION_ID, "code")
    ).resolves.toMatchObject({ status: "expired" });
    expect(authorizationCode.complete).not.toHaveBeenCalled();
  });
});

describe("ProviderAuthorizationCodeService cancel", () => {
  it("cancels a live transaction and leaves settled ones alone", async () => {
    const live = service(10_000, pending(), registry());
    await live.subject.cancel(USER_ID, "anthropic", TRANSACTION_ID);
    expect(live.transactions.finish).toHaveBeenCalledWith(
      TRANSACTION_ID,
      USER_ID,
      "cancelled",
      10_000
    );

    const settled = service(10_000, connected(5_000), registry());
    await settled.subject.cancel(USER_ID, "anthropic", TRANSACTION_ID);
    expect(settled.transactions.finish).not.toHaveBeenCalled();
  });
});
