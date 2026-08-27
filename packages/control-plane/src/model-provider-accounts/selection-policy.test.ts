import { describe, expect, it, vi } from "vitest";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import {
  ProviderAccountSelectionPolicy,
  ProviderAccountSelectionPolicyError,
} from "./selection-policy";

const ACCOUNT_ID = "1".repeat(32);

function account(overrides: Partial<ModelProviderAccount> = {}): ModelProviderAccount {
  return {
    id: ACCOUNT_ID,
    provider: "openai",
    displayName: "OpenAI account",
    externalAccountId: null,
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

function policy(value: ModelProviderAccount | null = account(), adapter: object | null = {}) {
  return new ProviderAccountSelectionPolicy(
    { getById: vi.fn(async () => value) },
    { get: vi.fn(() => adapter ?? undefined) }
  );
}

async function expectPolicyError(
  promise: Promise<unknown>,
  status: 400 | 404 | 409
): Promise<void> {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ProviderAccountSelectionPolicyError);
  expect(error).toMatchObject({ status });
}

describe("ProviderAccountSelectionPolicy", () => {
  it.each([
    [
      "selection",
      (value: ProviderAccountSelectionPolicy) => value.validateSelection("openai", "bad"),
    ],
    ["default", (value: ProviderAccountSelectionPolicy) => value.validateDefault("openai", "bad")],
  ])("rejects a malformed %s account ID with 400", async (_name, validate) => {
    await expectPolicyError(validate(policy()), 400);
  });

  it.each([
    ["missing", null, 404],
    ["provider mismatch", account({ provider: "xai" }), 400],
    ["disabled", account({ status: "disabled" }), 409],
    ["reconnect required", account({ status: "reconnect_required" }), 409],
    ["archived", account({ archivedAt: 2 }), 409],
  ] as const)("classifies a %s selection", async (_name, value, status) => {
    await expectPolicyError(policy(value).validateSelection("openai", ACCOUNT_ID), status);
  });

  it("rejects selection and default validation when the adapter is unavailable", async () => {
    const value = policy(account(), null);

    await expectPolicyError(value.validateSelection("openai", ACCOUNT_ID), 409);
    await expectPolicyError(value.validateDefault("openai", ACCOUNT_ID), 409);
  });

  it("returns the active matching account for selections and defaults", async () => {
    const value = account();
    const validator = policy(value);

    await expect(validator.validateSelection("openai", ACCOUNT_ID)).resolves.toBe(value);
    await expect(validator.validateDefault("openai", ACCOUNT_ID)).resolves.toBe(value);
  });
});
