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
  requirementPermissions,
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

describe("requirementPermissions", () => {
  it("maps each requirement to the permissions that can satisfy it", () => {
    expect(requirementPermissions(permissionRequirement("skills.read"))).toEqual(["skills.read"]);
    expect(requirementPermissions(requireSession("read").allOf[0])).toEqual(["sessions.read"]);
    expect(requirementPermissions(requireSession("sandbox").allOf[0])).toEqual([
      "sessions.sandbox_access",
    ]);
    expect(
      requirementPermissions({ kind: "automation", operation: "trigger", automationIdParam: "id" })
    ).toEqual(["automations.trigger.any", "automations.trigger.own"]);
    expect(requirementPermissions({ kind: "environment", idParam: "id", need: "use" })).toEqual([
      "environments.use",
    ]);
  });

  it("maps ownership-only decisions to no permission", () => {
    expect(requirementPermissions(requireSession("manageCollaborators").allOf[0])).toEqual([]);
    expect(requirementPermissions(requireSession("changeVisibility").allOf[0])).toEqual([]);
    expect(requirementPermissions(requireTeam("read").allOf[0])).toEqual([]);
  });
});

describe("personalAccessTokenRouteViolation", () => {
  it.each([
    ["a permission", requirePermission("sessions.read")],
    ["a session action", requireSession("read")],
    ["an automation operation", requireAutomation("trigger")],
    ["an environment need", requireEnvironment("read")],
    [
      "a team need beside a permission",
      requireAll(requireTeam("member").allOf[0], permissionRequirement("sessions.read")),
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
    ["team membership", requireTeam("read")],
    ["session collaborator management", requireSession("manageCollaborators")],
  ])("refuses a route decided only by %s", (_label, authorization) => {
    expect(personalAccessTokenRouteViolation(policy({ authorization }))).toMatch(
      /no requirement is decided by a permission/
    );
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

  it("keeps the owner's identity, role, and suspension", () => {
    const restricted = restrictAuthorizationToGrant({ ...owner, suspendedAt: 5 }, []);
    expect(restricted).toMatchObject({ userId: "user-1", suspendedAt: 5, role: owner.role });
    expect(restricted.permissions).toEqual([]);
  });
});
