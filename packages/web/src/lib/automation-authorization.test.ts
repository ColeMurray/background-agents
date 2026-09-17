import { describe, expect, it } from "vitest";
import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import { canAccessAutomation } from "./automation-authorization";

const CURRENT_USER_ID = "11111111111111111111111111111111";
const OTHER_USER_ID = "22222222222222222222222222222222";

function authorization(permissions: PermissionId[]): EffectiveAuthorization {
  return {
    userId: CURRENT_USER_ID,
    suspendedAt: null,
    role: { id: "role-1", key: null, name: "Test" },
    permissions,
  };
}

describe("canAccessAutomation", () => {
  it("allows any scope regardless of ownership", () => {
    expect(
      canAccessAutomation("automations.manage", authorization(["automations.manage.any"]), {
        userId: OTHER_USER_ID,
      })
    ).toBe(true);
  });

  it("allows own scope only for the canonical owner", () => {
    const auth = authorization(["automations.trigger.own"]);
    expect(canAccessAutomation("automations.trigger", auth, { userId: CURRENT_USER_ID })).toBe(
      true
    );
    expect(canAccessAutomation("automations.trigger", auth, { userId: OTHER_USER_ID })).toBe(false);
    expect(canAccessAutomation("automations.trigger", auth, { userId: null })).toBe(false);
  });

  it("denies missing authorization and unrelated capabilities", () => {
    expect(canAccessAutomation("automations.manage", null, { userId: CURRENT_USER_ID })).toBe(
      false
    );
    expect(
      canAccessAutomation("automations.manage", authorization(["automations.trigger.any"]), {
        userId: CURRENT_USER_ID,
      })
    ).toBe(false);
  });
});
