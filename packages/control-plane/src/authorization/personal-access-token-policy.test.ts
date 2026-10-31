import { describe, expect, it } from "vitest";
import { BUILT_IN_ROLE_REGISTRY, type EffectiveAuthorization } from "@open-inspect/shared/rbac";
import {
  activeGlobal,
  ACTIVE_SELF,
  permissionRequirement,
  requireAll,
  requireAutomation,
  requireEnvironment,
  requirePermission,
  requireSession,
  requireTeam,
  sessionRequirement,
  SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
  NO_AUTHORIZATION,
  type RouteAdmissionPolicy,
} from "../routes/shared";
import {
  personalAccessTokenRouteViolation,
  requirementNarrowing,
  restrictAuthorizationToGrant,
} from "./personal-access-token-policy";

function policy(overrides: Partial<RouteAdmissionPolicy>): RouteAdmissionPolicy {
  return {
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.read"),
    personalAccessTokens: "accept",
    ...overrides,
  };
}

describe("requirementNarrowing", () => {
  it("maps each permission-decided requirement to the permissions that can satisfy it", () => {
    expect(requirementNarrowing(permissionRequirement("skills.read"))).toEqual({
      kind: "permissions",
      permissions: ["skills.read"],
    });
    expect(requirementNarrowing(requireSession("read").allOf[0])).toEqual({
      kind: "permissions",
      permissions: ["sessions.read"],
    });
    expect(requirementNarrowing(requireSession("sandbox").allOf[0])).toEqual({
      kind: "permissions",
      permissions: ["sessions.sandbox_access"],
    });
    expect(
      requirementNarrowing({ kind: "automation", operation: "trigger", automationIdParam: "id" })
    ).toEqual({
      kind: "permissions",
      permissions: ["automations.trigger.any", "automations.trigger.own"],
    });
    expect(requirementNarrowing({ kind: "environment", idParam: "id", need: "use" })).toEqual({
      kind: "permissions",
      permissions: ["environments.use"],
    });
  });

  it.each([
    ["collaborator management", requireSession("manageCollaborators").allOf[0]],
    ["visibility changes", requireSession("changeVisibility").allOf[0]],
    ["team reads", requireTeam("read").allOf[0]],
    ["team membership", requireTeam("member").allOf[0]],
  ])("marks %s unsupported, since no grant decides them", (_label, requirement) => {
    expect(requirementNarrowing(requirement)).toMatchObject({ kind: "unsupported" });
  });
});

describe("personalAccessTokenRouteViolation", () => {
  it.each([
    ["a permission", requirePermission("sessions.read")],
    ["a session action", requireSession("read")],
    ["an automation operation", requireAutomation("trigger")],
    ["an environment need", requireEnvironment("read")],
    [
      "a session action beside a permission",
      requireAll(sessionRequirement("read"), permissionRequirement("skills.read")),
    ],
  ])("accepts an active-user route gated by %s", (_label, authorization) => {
    expect(personalAccessTokenRouteViolation(policy({ authorization }))).toBeNull();
  });

  it.each([SCM_AGNOSTIC_HUMAN_USER_ROUTE, SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE])(
    "accepts %o authentication",
    (route) => {
      expect(personalAccessTokenRouteViolation(policy(route))).toBeNull();
    }
  );

  it.each([
    SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
    SCM_AGNOSTIC_SANDBOX_ROUTE,
    SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
  ])("refuses %o authentication, which never verifies a token", (route) => {
    expect(
      personalAccessTokenRouteViolation(
        policy({
          ...route,
          authorization:
            route === SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE
              ? NO_AUTHORIZATION
              : requirePermission("sessions.read"),
        })
      )
    ).toMatch(/never verifies a personal access token/);
  });

  it.each([
    ["active-self", ACTIVE_SELF],
    ["active-global", activeGlobal()],
  ])("refuses %s authorization, which no grant can narrow", (_label, authorization) => {
    expect(personalAccessTokenRouteViolation(policy({ authorization }))).toMatch(
      /requires no permission a grant could narrow/
    );
  });

  it.each([
    ["team membership", requireTeam("read"), /team need "read" admits only a browser user/],
    [
      "session collaborator management",
      requireSession("manageCollaborators"),
      /session action "manageCollaborators" is decided by ownership/,
    ],
  ])("refuses a route decided only by %s", (_label, authorization, reason) => {
    expect(personalAccessTokenRouteViolation(policy({ authorization }))).toMatch(reason);
  });

  // Composition must not erase an exclusion: a token granted only the companion permission would
  // otherwise pass the ownership or membership check its grant cannot express.
  it.each([
    [
      "collaborator management",
      sessionRequirement("manageCollaborators"),
      /session action "manageCollaborators" is decided by ownership/,
    ],
    [
      "visibility changes",
      sessionRequirement("changeVisibility"),
      /session action "changeVisibility" is decided by ownership/,
    ],
    ["team membership", requireTeam("member").allOf[0], /team need "member" admits only/],
  ])("refuses %s composed beside a grantable permission", (_label, requirement, reason) => {
    for (const authorization of [
      requireAll(permissionRequirement("sessions.read"), requirement),
      requireAll(requirement, permissionRequirement("sessions.read")),
    ]) {
      expect(personalAccessTokenRouteViolation(policy({ authorization }))).toMatch(reason);
    }
  });

  it("refuses a route with no requirement", () => {
    expect(personalAccessTokenRouteViolation(policy({ authorization: requireAll() }))).toMatch(
      /has no requirement/
    );
  });

  it("refuses a withheld permission composed beside a grantable one", () => {
    expect(
      personalAccessTokenRouteViolation(
        policy({
          authorization: requireAll(
            permissionRequirement("sessions.read"),
            permissionRequirement("global_secrets.manage")
          ),
        })
      )
    ).toMatch(/"global_secrets.manage", which is withheld/);
  });

  it("refuses a route requiring a permission withheld from tokens", () => {
    expect(
      personalAccessTokenRouteViolation(
        policy({ authorization: requirePermission("global_secrets.manage") })
      )
    ).toMatch(/"global_secrets.manage", which is withheld/);
  });
});

describe("restrictAuthorizationToGrant", () => {
  const owner: EffectiveAuthorization = {
    userId: "user-1",
    suspendedAt: null,
    role: {
      id: BUILT_IN_ROLE_REGISTRY.administrator.id,
      key: "administrator",
      name: "Administrator",
    },
    permissions: ["sessions.read", "sessions.create", "global_secrets.manage", "skills.read"],
  };

  it("keeps only permissions both granted and held", () => {
    expect(
      restrictAuthorizationToGrant(owner, ["sessions.read", "automations.create"]).permissions
    ).toEqual(["sessions.read"]);
  });

  it("drops a granted permission that is withheld from tokens", () => {
    expect(
      restrictAuthorizationToGrant(owner, ["global_secrets.manage", "skills.read"]).permissions
    ).toEqual(["skills.read"]);
  });

  it("drops a granted permission whose prerequisite did not survive narrowing", () => {
    const manager = { ...owner, permissions: [...owner.permissions, "skills.manage" as const] };
    expect(
      restrictAuthorizationToGrant(manager, ["skills.manage", "skills.read"]).permissions
    ).toEqual(["skills.read", "skills.manage"]);
    // Granted only skills.manage, or granted both by an owner who no longer reads skills.
    expect(restrictAuthorizationToGrant(manager, ["skills.manage"]).permissions).toEqual([]);
    expect(
      restrictAuthorizationToGrant({ ...manager, permissions: ["skills.manage"] }, [
        "skills.manage",
        "skills.read",
      ]).permissions
    ).toEqual([]);
  });

  it("keeps the owner's identity, role, and suspension", () => {
    const restricted = restrictAuthorizationToGrant({ ...owner, suspendedAt: 5 }, []);
    expect(restricted).toMatchObject({ userId: "user-1", suspendedAt: 5, role: owner.role });
    expect(restricted.permissions).toEqual([]);
  });
});
