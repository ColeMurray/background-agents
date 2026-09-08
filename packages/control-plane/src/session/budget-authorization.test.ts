import { describe, expect, it } from "vitest";
import { canManageSessionBudget } from "./budget-authorization";

describe("canManageSessionBudget", () => {
  it("requires canonical ownership and lifecycle permission", () => {
    expect(
      canManageSessionBudget("owner", { userId: "owner", permissions: ["sessions.lifecycle"] })
    ).toBe(true);
    expect(
      canManageSessionBudget("owner", { userId: "member", permissions: ["sessions.lifecycle"] })
    ).toBe(false);
    expect(
      canManageSessionBudget("owner", { userId: "owner", permissions: ["sessions.read"] })
    ).toBe(false);
    expect(
      canManageSessionBudget(null, { userId: "owner", permissions: ["sessions.lifecycle"] })
    ).toBe(false);
    expect(canManageSessionBudget("owner", undefined)).toBe(false);
  });
});
