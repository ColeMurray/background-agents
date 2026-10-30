import { describe, expect, it } from "vitest";
import { PERMISSION_IDS, permissionsForBuiltInRole } from "../rbac";
import {
  PERSONAL_ACCESS_TOKEN_GRANT_PREREQUISITES,
  PERSONAL_ACCESS_TOKEN_GRANTABLE_PERMISSIONS,
  PERSONAL_ACCESS_TOKEN_MAX_LIFETIME_DAYS,
  PERSONAL_ACCESS_TOKEN_PREFIX,
  createPersonalAccessTokenRequestSchema,
  isPersonalAccessTokenFormat,
  isPersonalAccessTokenGrantable,
  personalAccessTokenMaxLifetimeDays,
  personalAccessTokenPolicyAllows,
  personalAccessTokenPolicySchema,
  unmetGrantPrerequisite,
  withGrantPrerequisitesMet,
} from "./personal-access-tokens";

const WELL_FORMED = `${PERSONAL_ACCESS_TOKEN_PREFIX}${"a1".repeat(32)}`;

describe("isPersonalAccessTokenFormat", () => {
  it("accepts the prefix followed by 64 lowercase hex characters", () => {
    expect(isPersonalAccessTokenFormat(WELL_FORMED)).toBe(true);
  });

  it.each([
    ["a truncated paste", WELL_FORMED.slice(0, -1)],
    ["trailing material", `${WELL_FORMED}0`],
    ["uppercase hex", WELL_FORMED.toUpperCase()],
    ["another prefix", WELL_FORMED.replace(PERSONAL_ACCESS_TOKEN_PREFIX, "oi_xyz_")],
    ["a bare secret", "a1".repeat(32)],
  ])("rejects %s", (_label, value) => {
    expect(isPersonalAccessTokenFormat(value)).toBe(false);
  });
});

describe("personal access token grantability", () => {
  it.each([
    "workspace.transfer_ownership",
    "workspace.members.manage",
    "workspace.members.merge",
    "global_secrets.manage",
    "repositories.secrets.manage",
    "environments.secrets.manage",
    "provider_accounts.manage",
    "integrations.manage",
    "mcp_servers.manage",
    "workspace.personal_access_tokens.manage",
  ] as const)("withholds workspace administration: %s", (permission) => {
    expect(isPersonalAccessTokenGrantable(permission)).toBe(false);
    expect(PERSONAL_ACCESS_TOKEN_GRANTABLE_PERMISSIONS).not.toContain(permission);
  });

  it("lets a token hold every permission the built-in viewer role has", () => {
    for (const permission of permissionsForBuiltInRole("viewer")) {
      expect(isPersonalAccessTokenGrantable(permission)).toBe(true);
    }
  });

  it("lists grantable permissions in registry order", () => {
    expect(PERSONAL_ACCESS_TOKEN_GRANTABLE_PERMISSIONS).toEqual(
      PERMISSION_IDS.filter((permission) => isPersonalAccessTokenGrantable(permission))
    );
  });
});

describe("createPersonalAccessTokenRequestSchema", () => {
  const valid = { name: " laptop ", permissions: ["sessions.read"], expiresInDays: 30 };

  it("trims the name", () => {
    expect(createPersonalAccessTokenRequestSchema.parse(valid).name).toBe("laptop");
  });

  it.each([
    ["an empty grant", { ...valid, permissions: [] }],
    ["an unregistered permission", { ...valid, permissions: ["sessions.everything"] }],
    ["no expiry", { name: "laptop", permissions: ["sessions.read"] }],
    [
      "a lifetime over the maximum",
      { ...valid, expiresInDays: PERSONAL_ACCESS_TOKEN_MAX_LIFETIME_DAYS + 1 },
    ],
    ["a fractional lifetime", { ...valid, expiresInDays: 1.5 }],
    ["a blank name", { ...valid, name: "   " }],
    ["unknown fields", { ...valid, scopes: ["read"] }],
  ])("rejects %s", (_label, body) => {
    expect(createPersonalAccessTokenRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("grant prerequisites", () => {
  it("names only grantable permissions on either side", () => {
    for (const [permission, prerequisites] of Object.entries(
      PERSONAL_ACCESS_TOKEN_GRANT_PREREQUISITES
    )) {
      expect(PERSONAL_ACCESS_TOKEN_GRANTABLE_PERMISSIONS).toContain(permission);
      for (const prerequisite of prerequisites ?? []) {
        expect(PERSONAL_ACCESS_TOKEN_GRANTABLE_PERMISSIONS).toContain(prerequisite);
      }
    }
  });

  it("finds a permission granted without its prerequisite", () => {
    expect(unmetGrantPrerequisite(["sessions.read", "skills.manage"])).toEqual({
      permission: "skills.manage",
      requires: "skills.read",
    });
    expect(unmetGrantPrerequisite(["skills.manage", "skills.read"])).toBeNull();
    expect(unmetGrantPrerequisite(["skills.read"])).toBeNull();
  });

  it("drops what a grant cannot exercise for want of a prerequisite", () => {
    expect(withGrantPrerequisitesMet(["sessions.read", "skills.manage"])).toEqual([
      "sessions.read",
    ]);
    expect(withGrantPrerequisitesMet(["skills.read", "skills.manage"])).toEqual([
      "skills.read",
      "skills.manage",
    ]);
  });
});

describe("personal access token policy", () => {
  const open = { enabled: true, maxLifetimeDays: null, allowedPermissions: null };

  it("defaults the lifetime cap to the system maximum", () => {
    expect(personalAccessTokenMaxLifetimeDays(open)).toBe(PERSONAL_ACCESS_TOKEN_MAX_LIFETIME_DAYS);
    expect(personalAccessTokenMaxLifetimeDays({ ...open, maxLifetimeDays: 30 })).toBe(30);
  });

  it("allows every grantable permission without a ceiling, and never a withheld one", () => {
    expect(personalAccessTokenPolicyAllows(open, "sessions.read")).toBe(true);
    expect(personalAccessTokenPolicyAllows(open, "global_secrets.manage")).toBe(false);
  });

  it("allows only the ceiling's permissions when one is set", () => {
    const ceiling = { ...open, allowedPermissions: ["sessions.read" as const] };
    expect(personalAccessTokenPolicyAllows(ceiling, "sessions.read")).toBe(true);
    expect(personalAccessTokenPolicyAllows(ceiling, "automations.create")).toBe(false);
  });

  it.each([
    ["a lifetime over the system maximum", { ...open, maxLifetimeDays: 366 }],
    ["an unregistered permission", { ...open, allowedPermissions: ["sessions.everything"] }],
    ["a missing switch", { maxLifetimeDays: null, allowedPermissions: null }],
  ])("rejects %s", (_label, policy) => {
    expect(personalAccessTokenPolicySchema.safeParse(policy).success).toBe(false);
  });
});
