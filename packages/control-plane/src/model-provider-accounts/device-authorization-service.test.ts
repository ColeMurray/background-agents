import { describe, expect, it, vi } from "vitest";
import { ModelProviderAccountAdapterRegistry } from "../auth/model-provider-account-adapters";
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

function service(now: number, transaction: ProviderAuthorization) {
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
    btoa("x".repeat(32)),
    new ModelProviderAccountAdapterRegistry([]),
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
