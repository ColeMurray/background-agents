import { describe, expect, it, vi } from "vitest";
import { ModelProviderAccountAdapterRegistry } from "../auth/model-provider-account-adapters";
import type { ProviderAuthorizationRow } from "../db/provider-account-authorizations";
import { ProviderDeviceAuthorizationService } from "./device-authorization-service";

const TRANSACTION_ID = "01".repeat(32);

function row(overrides: Partial<ProviderAuthorizationRow> = {}): ProviderAuthorizationRow {
  return {
    id: TRANSACTION_ID,
    user_id: "user-1",
    provider: "openai",
    operation: "create",
    provider_account_id: null,
    target_account_status: null,
    target_account_lifecycle_version: null,
    display_name: "OpenAI",
    encrypted_provider_data: "encrypted",
    provider_state_version: 1,
    interval_ms: 5_000,
    next_poll_at: 20_000,
    expires_at: 100_000,
    state: "pending",
    processing_owner: null,
    processing_started_at: null,
    result_provider_account_id: null,
    reconnected_existing: null,
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    ...overrides,
  };
}

function service(now: number, transaction: ProviderAuthorizationRow) {
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
        state: "denied" | "expired" | "failed" | "cancelled" | "superseded",
        completedAt: number
      ) => {
        current = {
          ...current,
          state,
          encrypted_provider_data: null,
          provider_state_version: null,
          processing_owner: null,
          processing_started_at: null,
          completed_at: completedAt,
        };
        return true;
      }
    ),
    expire: vi.fn(async (_id, _userId, _state, _owner, completedAt) => {
      current = {
        ...current,
        state: "expired",
        encrypted_provider_data: null,
        provider_state_version: null,
        processing_owner: null,
        processing_started_at: null,
        completed_at: completedAt,
      };
      return true;
    }),
    claim: vi.fn(async () => true),
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
    setCurrent: (next: ProviderAuthorizationRow) => (current = next),
  };
}

describe("ProviderDeviceAuthorizationService polling", () => {
  it("returns an early poll from durable state without dispatching a provider", async () => {
    const { subject } = service(10_000, row());
    await expect(subject.poll("user-1", "openai", TRANSACTION_ID)).resolves.toEqual({
      status: "pending",
      expiresAt: 100_000,
      pollIntervalMs: 5_000,
      nextPollAt: 20_000,
    });
  });

  it("fails a stale processing claim closed instead of stealing it", async () => {
    const transaction = row({
      state: "processing",
      processing_owner: "old-owner",
      processing_started_at: 10_000,
    });
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
    const { subject } = service(10_000, row({ provider: "xai" }));
    await expect(subject.poll("user-1", "openai", TRANSACTION_ID)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("logs a provider poll failure before failing closed", async () => {
    const { subject, logger } = service(10_000, row({ next_poll_at: 0 }));

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
      const initial = row({ next_poll_at: 0 });
      const { subject, transactions, setCurrent } = service(10_000, initial);
      transactions.claim.mockImplementationOnce(async () => {
        setCurrent(
          row(
            winner === "connected"
              ? {
                  state: "connected",
                  encrypted_provider_data: null,
                  provider_state_version: null,
                  result_provider_account_id: "account-1",
                  reconnected_existing: 0,
                  completed_at: 10_000,
                }
              : {
                  state: "cancelled",
                  encrypted_provider_data: null,
                  provider_state_version: null,
                  completed_at: 10_000,
                }
          )
        );
        return false;
      });

      await expect(subject.poll("user-1", "openai", TRANSACTION_ID)).resolves.toMatchObject({
        status: winner,
      });
    }
  );
});
