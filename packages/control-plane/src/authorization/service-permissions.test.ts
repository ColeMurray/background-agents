import { describe, expect, it } from "vitest";
import { serviceAllowsPermission } from "./service-permissions";

describe("serviceAllowsPermission", () => {
  it("allows launch capabilities but denies management capabilities", () => {
    expect(serviceAllowsPermission("slack-bot", "sessions.create")).toBe(true);
    expect(serviceAllowsPermission("linear-bot", "integrations.read")).toBe(true);
    expect(serviceAllowsPermission("slack-bot", "global_secrets.manage")).toBe(false);
    expect(serviceAllowsPermission("github-bot", "sessions.sandbox_access")).toBe(false);
  });

  it("limits Agent World to repository use and session lifecycle", () => {
    for (const permission of [
      "repositories.read",
      "repositories.use",
      "sessions.create",
      "sessions.read",
      "sessions.collaborate",
      "sessions.lifecycle",
      "skills.read",
    ] as const) {
      expect(serviceAllowsPermission("agent-world", permission), permission).toBe(true);
    }
    for (const permission of [
      "environments.use",
      "integrations.read",
      "sessions.sandbox_access",
      "sessions.delete",
      "skills.manage",
      "global_secrets.manage",
      "provider_accounts.manage",
      "automations.read",
      "workspace.members.manage",
    ] as const) {
      expect(serviceAllowsPermission("agent-world", permission), permission).toBe(false);
    }
  });
});
