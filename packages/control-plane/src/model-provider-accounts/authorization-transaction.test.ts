import { describe, expect, it, vi } from "vitest";
import { ANTHROPIC_EXCHANGE_TIMEOUT_MS } from "../auth/anthropic";
import { PROVIDER_TOKEN_REFRESH_TIMEOUT_MS } from "../auth/provider-token-timeouts";
import type { ProviderAuthorization } from "../db/provider-account-authorizations";
import {
  PROVIDER_AUTHORIZATION_PROCESSING_CLAIM_TIMEOUT_MS,
  ownedAuthorization,
} from "./authorization-transaction";

const row: ProviderAuthorization = {
  id: "01".repeat(32),
  userId: "user-1",
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
};

describe("provider authorization transactions", () => {
  it("holds a processing claim well beyond any provider call made under it", () => {
    // A claim that lapses while its own exchange is still within timeout lets
    // a status request fail a healthy transaction and strand the minted token.
    expect(PROVIDER_AUTHORIZATION_PROCESSING_CLAIM_TIMEOUT_MS).toBeGreaterThanOrEqual(
      2 * ANTHROPIC_EXCHANGE_TIMEOUT_MS
    );
    expect(PROVIDER_AUTHORIZATION_PROCESSING_CLAIM_TIMEOUT_MS).toBeGreaterThanOrEqual(
      2 * PROVIDER_TOKEN_REFRESH_TIMEOUT_MS
    );
  });

  it("owns a transaction only under its provider and completion kind", async () => {
    const transactions = { getOwned: vi.fn(async () => row) };

    await expect(
      ownedAuthorization(transactions, "user-1", "anthropic", "authorization_code", row.id)
    ).resolves.toBe(row);
    await expect(
      ownedAuthorization(transactions, "user-1", "anthropic", "device", row.id)
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      ownedAuthorization(transactions, "user-1", "openai", "authorization_code", row.id)
    ).rejects.toMatchObject({ status: 404 });
  });
});
