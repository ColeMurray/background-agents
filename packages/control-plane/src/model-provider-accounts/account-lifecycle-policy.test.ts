import { describe, expect, it } from "vitest";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import { providerAccountIneligibility } from "./account-lifecycle-policy";

function account(overrides: Partial<ModelProviderAccount> = {}): ModelProviderAccount {
  return {
    id: "0123456789abcdef0123456789abcdef",
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

describe("providerAccountIneligibility", () => {
  it.each(["disabled", "reconnect_required"] as const)(
    "rejects %s accounts for active use",
    (status) => {
      expect(providerAccountIneligibility(account({ status }), "active_use")).toBe(status);
    }
  );

  it("rejects archived accounts for every operation", () => {
    const archived = account({ archivedAt: 2 });
    expect(providerAccountIneligibility(archived, "active_use")).toBe("archived");
    expect(providerAccountIneligibility(archived, "reconnect")).toBe("archived");
  });

  it.each(["active", "disabled", "reconnect_required"] as const)(
    "allows reconnect for a non-archived %s account",
    (status) => {
      expect(providerAccountIneligibility(account({ status }), "reconnect")).toBeNull();
    }
  );
});
