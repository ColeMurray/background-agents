import { describe, expect, it } from "vitest";
import type { SessionViewer } from "@open-inspect/shared";
import { visibleSessionsPredicate } from "./session-visibility";

const member: SessionViewer = {
  kind: "user",
  userId: "user-a",
  roleKey: "member",
  permissions: ["sessions.read"],
  suspended: false,
  memberships: new Map([["team-a", "member"]]),
};

describe("visibleSessionsPredicate", () => {
  it("uses the persisted row and membership for team access when enforcement is on", () => {
    const { sql, params } = visibleSessionsPredicate("s", member, { mode: "on" });
    expect(sql).toContain("s.visibility = 'workspace'");
    expect(sql).toContain("tm.team_id = s.owner_team_id AND tm.user_id = ?");
    expect(sql).toContain("sc.session_id = s.id AND sc.user_id = ?");
    expect(params).toEqual([0, "user-a", "user-a", "user-a"]);
  });

  it.each(["off", "shadow"] as const)(
    "never lists another user's private session in %s",
    (mode) => {
      const { sql, params } = visibleSessionsPredicate("root", member, { mode });
      expect(sql).not.toContain("team_memberships");
      expect(sql).toContain("root.visibility != 'private'");
      expect(sql).toContain("root.user_id = ?");
      expect(params).toEqual(["user-a", "user-a"]);
    }
  );

  it("excludes private rows for owners even when they can break glass by ID", () => {
    const owner: SessionViewer = { ...member, roleKey: "owner" };
    const result = visibleSessionsPredicate("s", owner, { mode: "on", excludePrivate: true });
    expect(result.sql).not.toContain("session_collaborators");
    expect(result.params).toEqual([1, "user-a"]);
  });

  it("keeps service readers outside private sessions and scopes bound services", () => {
    expect(visibleSessionsPredicate("s", { kind: "service", teamId: null })).toEqual({
      sql: "s.visibility != 'private'",
      params: [],
    });
    const bound = visibleSessionsPredicate("s", { kind: "service", teamId: "team-a" });
    expect(bound.sql).toContain("s.owner_team_id = ?");
    expect(bound.params).toEqual(["team-a"]);
  });
});
