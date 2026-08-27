import { describe, expect, it, vi } from "vitest";
import {
  ModelProviderAccountAdapterRegistry,
  type ProviderDeviceAuthorizationCapability,
  type ProviderDeviceAuthorizationPollResult,
} from "../auth/model-provider-account-adapters";
import {
  OpenAIModelProviderAccountAdapter,
  type OpenAIProviderCredential,
} from "../auth/model-provider-account-openai-adapter";
import { encryptProviderAuthorizationPayload } from "../auth/provider-account-crypto";
import type {
  ConnectedProviderAuthorization,
  PendingProviderAuthorization,
  ProcessingProviderAuthorization,
  ProviderAuthorization,
  ProviderAuthorizationTerminalState,
  TerminalProviderAuthorization,
} from "../db/provider-account-authorizations";
import { ProviderDeviceAuthorizationService } from "./device-authorization-service";

const TRANSACTION_ID = "01".repeat(32);
const ENCRYPTION_KEY = btoa("x".repeat(32));
type CreatePendingProviderAuthorization = Extract<
  PendingProviderAuthorization,
  { operation: "create" }
>;

function pending(
  overrides: Partial<CreatePendingProviderAuthorization> = {}
): CreatePendingProviderAuthorization {
  return {
    id: TRANSACTION_ID,
    userId: "user-1",
    provider: "openai",
    operation: "create",
    displayName: "OpenAI",
    encryptedProviderData: "encrypted",
    providerStateVersion: 1,
    intervalMs: 5_000,
    nextPollAt: 20_000,
    expiresAt: 100_000,
    state: "pending",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function processing(
  authorization: PendingProviderAuthorization,
  processingOwner: string,
  processingStartedAt: number
): ProcessingProviderAuthorization {
  return {
    ...authorization,
    state: "processing",
    processingOwner,
    processingStartedAt,
  };
}

function connected(completedAt: number): ConnectedProviderAuthorization {
  return {
    id: TRANSACTION_ID,
    userId: "user-1",
    provider: "openai",
    operation: "create",
    displayName: "OpenAI",
    intervalMs: 5_000,
    nextPollAt: 0,
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

function deviceAuthorization(
  intervalMs: number,
  pollResult: ProviderDeviceAuthorizationPollResult<OpenAIProviderCredential> = {
    status: "pending",
  }
): ProviderDeviceAuthorizationCapability<OpenAIProviderCredential, unknown> {
  return {
    stateSchemaVersion: 1,
    start: vi.fn(async () => ({
      providerState: { deviceAuthId: "device-1" },
      userCode: "ABCD-EFGH",
      verificationUrl: "https://example.com/device",
      intervalMs,
    })),
    parseState: vi.fn((payload) => payload),
    poll: vi.fn(async () => pollResult),
  };
}

function service(
  now: number,
  transaction: ProviderAuthorization,
  adapters = new ModelProviderAccountAdapterRegistry([])
) {
  let current = transaction;
  const transactions = {
    recordAttempt: vi.fn(async () => true),
    reserve: vi.fn(async () => true),
    activate: vi.fn(async () => true),
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
      current = processing(current, owner, claimedAt);
      return current;
    }),
    returnPending: vi.fn(async () => true),
  };
  const account = {
    id: "account-1",
    provider: "openai" as const,
    displayName: "OpenAI",
    externalAccountId: "external-1",
    status: "active" as const,
    createdBy: "user-1",
    updatedBy: "user-1",
    lastVerifiedAt: now,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  const logger = { error: vi.fn() };
  const subject = new ProviderDeviceAuthorizationService(
    transactions,
    {
      getLifecycleSnapshot: vi.fn(async () => null),
      getById: vi.fn(async () => account),
    },
    { finalizeTrustedConnection: vi.fn(async () => true) },
    ENCRYPTION_KEY,
    adapters,
    { generateId: (bytes) => "ab".repeat(bytes), now: () => now },
    logger
  );
  return {
    subject,
    transactions,
    logger,
    setCurrent: (next: ProviderAuthorization) => (current = next),
  };
}

describe("ProviderDeviceAuthorizationService polling", () => {
  it("returns an early poll from durable state without dispatching a provider", async () => {
    const { subject } = service(10_000, pending());
    await expect(subject.poll("user-1", "openai", TRANSACTION_ID)).resolves.toEqual({
      status: "pending",
      expiresAt: 100_000,
      pollIntervalMs: 5_000,
      nextPollAt: 20_000,
    });
  });

  it("fails a stale processing claim closed instead of stealing it", async () => {
    const transaction = processing(pending(), "old-owner", 10_000);
    const { subject, transactions } = service(40_000, transaction);
    await expect(subject.poll("user-1", "openai", TRANSACTION_ID)).resolves.toMatchObject({
      status: "failed",
      retryable: true,
    });
    expect(transactions.finish).toHaveBeenCalledWith(
      TRANSACTION_ID,
      "user-1",
      "failed",
      40_000,
      "old-owner"
    );
  });

  it("does not reveal whether another provider owns a transaction ID", async () => {
    const { subject } = service(10_000, pending({ provider: "xai" }));
    await expect(subject.poll("user-1", "openai", TRANSACTION_ID)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("logs a provider poll failure before failing closed", async () => {
    const { subject, logger } = service(10_000, pending({ nextPollAt: 0 }));

    await expect(subject.poll("user-1", "openai", TRANSACTION_ID)).resolves.toMatchObject({
      status: "failed",
    });
    expect(logger.error).toHaveBeenCalledWith("provider_device_authorization.poll_failed", {
      transaction_id: TRANSACTION_ID,
      provider: "openai",
      error: expect.any(Error),
    });
  });

  it("bounds a provider-supplied pending interval before persisting it", async () => {
    const capability = deviceAuthorization(5_000, { status: "pending", intervalMs: 90_000 });
    const adapters = new ModelProviderAccountAdapterRegistry([
      new OpenAIModelProviderAccountAdapter(undefined, capability),
    ]);
    const encryptedProviderData = await encryptProviderAuthorizationPayload(
      { deviceAuthId: "device-1" },
      ENCRYPTION_KEY,
      { transactionId: TRANSACTION_ID, provider: "openai", stateSchemaVersion: 1 }
    );
    const { subject, transactions } = service(
      10_000,
      pending({ nextPollAt: 0, encryptedProviderData }),
      adapters
    );

    await expect(subject.poll("user-1", "openai", TRANSACTION_ID)).resolves.toMatchObject({
      status: "pending",
      pollIntervalMs: 60_000,
      nextPollAt: 70_000,
    });
    expect(transactions.returnPending).toHaveBeenCalledWith(
      expect.anything(),
      70_000,
      60_000,
      10_000
    );
  });

  it.each(["connected", "cancelled"] as const)(
    "returns the durable %s winner when a claim CAS loses",
    async (winner) => {
      const initial = pending({ nextPollAt: 0 });
      const { subject, transactions, setCurrent } = service(10_000, initial);
      transactions.claim.mockImplementationOnce(async () => {
        setCurrent(
          winner === "connected" ? connected(10_000) : terminal(initial, "cancelled", 10_000)
        );
        return null;
      });

      await expect(subject.poll("user-1", "openai", TRANSACTION_ID)).resolves.toMatchObject({
        status: winner,
      });
    }
  );
});

describe("ProviderDeviceAuthorizationService start", () => {
  it.each([
    [500, 1_000],
    [90_000, 60_000],
  ])("bounds a provider interval of %i ms to %i ms", async (providerInterval, expected) => {
    const capability = deviceAuthorization(providerInterval);
    const adapters = new ModelProviderAccountAdapterRegistry([
      new OpenAIModelProviderAccountAdapter(undefined, capability),
    ]);
    const { subject, transactions } = service(10_000, pending(), adapters);

    const result = await subject.start("user-1", "openai", {
      operation: "create",
      displayName: "OpenAI",
    });

    expect(result.pollIntervalMs).toBe(expected);
    expect(transactions.activate).toHaveBeenCalledWith(
      result.transactionId,
      "user-1",
      expect.any(String),
      1,
      expected,
      expect.any(Number),
      10_000
    );
  });
});
