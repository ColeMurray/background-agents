import { describe, expect, it } from "vitest";
import { SERVICE_NAMES } from "@open-inspect/shared/service-auth";
import { serviceAllowsPermission } from "./service-permissions";

describe("serviceAllowsPermission", () => {
  it("allows launch capabilities but denies management capabilities", () => {
    expect(serviceAllowsPermission("slack-bot", "sessions.create")).toBe(true);
    expect(serviceAllowsPermission("linear-bot", "integrations.read")).toBe(true);
    expect(serviceAllowsPermission("slack-bot", "global_secrets.manage")).toBe(false);
    expect(serviceAllowsPermission("github-bot", "sessions.sandbox_access")).toBe(false);
  });

  it("does not grant bulk export to bot services", () => {
    for (const service of SERVICE_NAMES.filter((service) => service !== "web")) {
      expect(serviceAllowsPermission(service, "sessions.export")).toBe(false);
    }
  });
});
