import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import type { TeamRole } from "@open-inspect/shared/types/teams";
import type { Principal } from "../auth/principal";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import type { SqlDatabase } from "../db/sql-database";
import { TeamMembershipStore } from "../db/team-memberships";
import type { RequestContext } from "../http/request-context";
import { resourceViewer, viewerForUser } from "./resource-viewer";
import { AuthorizationError, AuthorizationService } from "./service";

const db: SqlDatabase = {
  prepare: () => {
    throw new Error("Unexpected SQL query");
  },
  batch: async () => [],
};
const memberships = new Map<string, TeamRole>([["team", "lead"]]);
const actor = {
  provider: "slack",
  providerUserId: "U123",
  canonicalUserId: "user",
  participantUserId: "slack:U123",
} as const;

function authorization(): EffectiveAuthorization {
  return {
    userId: "user",
    role: { id: "custom-role", key: null, name: "Custom" },
    permissions: ["sessions.read", "sessions.collaborate"],
    suspendedAt: null,
  };
}

function context(): RequestContext {
  return {
    db,
    request_id: "resource-viewer",
    trace_id: "resource-viewer",
    metrics: createRequestMetrics(),
    executionCtx: createTestBackgroundTasks(),
    principal: { kind: "user", userId: "user" },
    authorization: authorization(),
  };
}

beforeEach(() => {
  vi.spyOn(TeamMembershipStore.prototype, "listForUser").mockResolvedValue(memberships);
});
afterEach(() => vi.restoreAllMocks());

describe("resourceViewer", () => {
  it.each([
    undefined,
    { kind: "user", userId: "user" },
    { kind: "sandbox", sessionId: "session" },
    { kind: "service", service: "slack-bot", actor },
    {
      kind: "service",
      service: "slack-bot",
      actor: { ...actor, canonicalUserId: null },
    },
  ] satisfies (Principal | undefined)[])(
    "rejects missing authorization for principal %j before loading memberships",
    async (principal) => {
      const ctx = context();
      ctx.principal = principal;
      delete ctx.authorization;
      ctx.sessionMemberships = new Map();
      await expect(resourceViewer(ctx)).rejects.toThrow("Missing request authorization");
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, null, "team"])(
    "builds an actorless service viewer with scope %j without a membership query",
    async (teamId) => {
      const ctx = context();
      ctx.principal = { kind: "service", service: "slack-bot", actor: null };
      delete ctx.authorization;
      ctx.serviceTeamId = teamId;
      await expect(resourceViewer(ctx)).resolves.toEqual({
        kind: "service",
        teamId: teamId ?? null,
      });
      expect(ctx.sessionMemberships).toBeUndefined();
      expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
    }
  );

  it("maps a verified service actor from effective authorization, not the provider identity", async () => {
    const ctx = context();
    ctx.principal = { kind: "service", service: "slack-bot", actor };
    const viewer = await resourceViewer(ctx);
    expect(viewer).toEqual({
      kind: "user",
      userId: "user",
      roleKey: null,
      permissions: ctx.authorization!.permissions,
      suspended: false,
      memberships,
    });
    expect(TeamMembershipStore.prototype.listForUser).toHaveBeenCalledWith("user");
  });

  it.each([memberships, new Map<string, TeamRole>()])(
    "reuses loaded memberships within a request, including an empty result",
    async (roles) => {
      vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(roles);
      const ctx = context();
      expect(await resourceViewer(ctx)).toHaveProperty("memberships", roles);
      expect(await resourceViewer(ctx)).toHaveProperty("memberships", roles);
      expect(ctx.sessionMemberships).toBe(roles);
      expect(TeamMembershipStore.prototype.listForUser).toHaveBeenCalledTimes(1);
      await resourceViewer(context());
      expect(TeamMembershipStore.prototype.listForUser).toHaveBeenCalledTimes(2);
    }
  );

  it("preserves a genuine empty membership cache", async () => {
    const ctx = context();
    const emptyMemberships = new Map<string, TeamRole>();
    ctx.sessionMemberships = emptyMemberships;
    const viewer = await resourceViewer(ctx);
    expect(viewer.kind === "user" && viewer.memberships).toBe(emptyMemberships);
    expect(ctx.sessionMemberships).toBe(emptyMemberships);
    expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
  });

  it("does not cache a rollback membership skip", async () => {
    const ctx = context();
    expect(await resourceViewer(ctx, false)).toHaveProperty("memberships", new Map());
    expect(ctx.sessionMemberships).toBeUndefined();
    expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
    expect(await resourceViewer(ctx)).toHaveProperty("memberships", memberships);
    expect(ctx.sessionMemberships).toBe(memberships);
  });

  it("preserves suspension from request authorization", async () => {
    const ctx = context();
    ctx.authorization!.suspendedAt = 1;
    ctx.authorization!.permissions = [];
    expect(await resourceViewer(ctx)).toMatchObject({ suspended: true, permissions: [] });
  });

  it("propagates membership failures without caching an empty fallback", async () => {
    const cause = new Error("Membership database unavailable");
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockRejectedValueOnce(cause);
    const ctx = context();
    await expect(resourceViewer(ctx)).rejects.toBe(cause);
    expect(ctx.sessionMemberships).toBeUndefined();
    expect(await resourceViewer(ctx)).toHaveProperty("memberships", memberships);
  });
});

describe("viewerForUser", () => {
  beforeEach(() => {
    vi.spyOn(AuthorizationService.prototype, "getEffectiveAuthorization").mockResolvedValue(
      authorization()
    );
  });

  it("loads live effective authorization and memberships for a named user", async () => {
    const first = await viewerForUser(db, "user");
    expect(first).toEqual({
      authorization: authorization(),
      viewer: {
        kind: "user",
        userId: "user",
        roleKey: null,
        permissions: authorization().permissions,
        suspended: false,
        memberships,
      },
    });
    vi.mocked(TeamMembershipStore.prototype.listForUser).mockResolvedValue(new Map());
    expect(await viewerForUser(db, "user")).toHaveProperty("viewer.memberships", new Map());
    expect(AuthorizationService.prototype.getEffectiveAuthorization).toHaveBeenCalledWith("user");
    expect(AuthorizationService.prototype.getEffectiveAuthorization).toHaveBeenCalledTimes(2);
    expect(TeamMembershipStore.prototype.listForUser).toHaveBeenCalledWith("user");
    expect(TeamMembershipStore.prototype.listForUser).toHaveBeenCalledTimes(2);
  });

  it("returns null for an authorization denial without loading memberships", async () => {
    vi.mocked(AuthorizationService.prototype.getEffectiveAuthorization).mockRejectedValue(
      new AuthorizationError(403, "assignment_required")
    );
    await expect(viewerForUser(db, "unassigned-user")).resolves.toBeNull();
    expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
  });

  it.each(["authorization", "memberships"])(
    "propagates infrastructure failures from %s",
    async (source) => {
      const cause = new Error("Database unavailable");
      if (source === "authorization") {
        vi.mocked(AuthorizationService.prototype.getEffectiveAuthorization).mockRejectedValue(
          cause
        );
      } else {
        vi.mocked(TeamMembershipStore.prototype.listForUser).mockRejectedValue(cause);
      }
      await expect(viewerForUser(db, "user")).rejects.toBe(cause);
      if (source === "authorization") {
        expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
      }
    }
  );

  it("preserves suspension and skips membership loading for a suspended named user", async () => {
    const suspended = { ...authorization(), suspendedAt: 1, permissions: [] };
    vi.mocked(AuthorizationService.prototype.getEffectiveAuthorization).mockResolvedValue(
      suspended
    );
    const result = await viewerForUser(db, "user");
    expect(result?.authorization).toBe(suspended);
    expect(result?.viewer).toMatchObject({
      suspended: true,
      permissions: [],
      memberships: new Map(),
    });
    expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
  });

  it("can skip memberships without skipping effective authorization", async () => {
    const result = await viewerForUser(db, "user", false);
    expect(result?.authorization).toEqual(authorization());
    expect(result?.viewer).toMatchObject({ suspended: false, memberships: new Map() });
    expect(AuthorizationService.prototype.getEffectiveAuthorization).toHaveBeenCalledWith("user");
    expect(TeamMembershipStore.prototype.listForUser).not.toHaveBeenCalled();
  });
});
