import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAndValidateAutomationProviderSelections } from "./automation-provider-selection";
import { ProviderAccountSelectionPolicyError } from "./selection-policy";

const mockGetById = vi.hoisted(() => vi.fn());
const mockAdapterGet = vi.hoisted(() => vi.fn());

vi.mock("../db/model-provider-accounts", () => ({
  ModelProviderAccountStore: vi.fn().mockImplementation(function () {
    return { getById: mockGetById };
  }),
}));

vi.mock("../auth/model-provider-account-default-adapters", () => ({
  modelProviderAccountAdapterRegistry: { get: mockAdapterGet },
}));

describe("automation provider selections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapterGet.mockReturnValue({});
    mockGetById.mockResolvedValue({
      id: "0123456789abcdef0123456789abcdef",
      provider: "openai",
      status: "active",
      archivedAt: null,
    });
  });

  it("parses API-key and provider-account selections", async () => {
    const selections = {
      openai: {
        mode: "provider_account" as const,
        accountId: "0123456789abcdef0123456789abcdef",
      },
      xai: { mode: "api_key" as const },
    };

    await expect(
      parseAndValidateAutomationProviderSelections({} as D1Database, selections)
    ).resolves.toEqual(selections);
    expect(mockGetById).toHaveBeenCalledOnce();
  });

  it("preserves schema issue paths in validation errors", async () => {
    await expect(
      parseAndValidateAutomationProviderSelections({} as D1Database, {
        openai: { mode: "provider_account", accountId: "short" },
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "AutomationProviderSelectionError",
        message: expect.stringMatching(/^providerSelections\.openai\.accountId:/),
      })
    );
  });

  it.each([
    ["unavailable adapter", undefined, null, "openai provider account adapter is unavailable"],
    ["missing account", {}, null, "Selected openai provider account was not found"],
    [
      "wrong provider",
      {},
      { provider: "xai", status: "active", archivedAt: null },
      "Selected provider account does not belong to openai",
    ],
    [
      "inactive account",
      {},
      { provider: "openai", status: "disabled", archivedAt: null },
      "Selected openai provider account is unavailable",
    ],
    [
      "archived account",
      {},
      { provider: "openai", status: "active", archivedAt: 1 },
      "Selected openai provider account is unavailable",
    ],
  ])("rejects an %s", async (_label, adapter, account, message) => {
    mockAdapterGet.mockReturnValue(adapter);
    mockGetById.mockResolvedValue(account);

    await expect(
      parseAndValidateAutomationProviderSelections({} as D1Database, {
        openai: {
          mode: "provider_account",
          accountId: "0123456789abcdef0123456789abcdef",
        },
      })
    ).rejects.toEqual(expect.objectContaining({ name: "Error", message }));
    await expect(
      parseAndValidateAutomationProviderSelections({} as D1Database, {
        openai: {
          mode: "provider_account",
          accountId: "0123456789abcdef0123456789abcdef",
        },
      })
    ).rejects.toBeInstanceOf(ProviderAccountSelectionPolicyError);
  });
});
