import { describe, expect, it } from "vitest";
import { buildSessionListPredicates } from "./session-list-predicates";

const collapse = (sql: string) => sql.replace(/\s+/g, " ").trim();
const internal = {
  readScope: { kind: "internal", reason: "test filter SQL" },
  mode: "on",
} as const;

describe("buildSessionListPredicates", () => {
  it("combines participation, workspace, and row visibility before pagination", () => {
    const result = buildSessionListPredicates({
      ownerFilter: "participating",
      scope: "workspace",
      teamIds: ["team-a"],
      visibility: "team",
      readScope: {
        kind: "user",
        userId: "user-a",
        roleKey: "member",
        suspended: false,
        permissions: ["sessions.read"],
        memberships: new Map(),
      },
      mode: "on",
    });
    expect(result.where).toContain("session_read_states");
    expect(result.where).toContain("owner_team_id IS NULL");
    expect(result.where).toContain("owner_team_id IN (?)");
    expect(result.where).toContain("visibility = ?");
    expect(result.where).toContain("team_memberships");
    expect(result.params).toContain("user-a");
  });

  it("requires an explicit internal scope for an unfiltered list", () => {
    expect(buildSessionListPredicates(internal)).toEqual({ where: "", params: [] });
  });

  it("binds each filter in clause order", () => {
    const { where, params } = buildSessionListPredicates({
      ...internal,
      status: "active",
      excludeStatus: "archived",
      excludeAutomationLineage: true,
      createdByUserIds: ["alice", "bob"],
      environmentId: "env-1",
      spawnSource: "agent",
    });
    expect(collapse(where)).toBe(
      "WHERE status = ? AND status != ? AND automation_id IS NULL AND spawn_source NOT IN ('automation', 'github-bot') AND user_id IN (?, ?) AND environment_id = ? AND spawn_source = ?"
    );
    expect(params).toEqual(["active", "archived", "alice", "bob", "env-1", "agent"]);
  });

  it("matches a repository by normalized identity through the scalar primary or any member row", () => {
    const { where, params } = buildSessionListPredicates({
      ...internal,
      repository: { repoOwner: " Acme ", repoName: "Web-App" },
    });
    expect(collapse(where)).toBe(
      "WHERE ((repo_owner = ? AND repo_name = ?) OR sessions.id IN ( SELECT session_id FROM session_repositories WHERE repo_owner = ? AND repo_name = ? ))"
    );
    expect(where).not.toContain("LOWER(");
    expect(params).toEqual(["acme", "web-app", "acme", "web-app"]);
  });

  it("binds escaped LIKE patterns for title, id prefix, and repository labels", () => {
    const { where, params } = buildSessionListPredicates({ ...internal, search: "50%_off\\" });
    expect(where).not.toContain("50%");
    expect(collapse(where)).toBe(
      "WHERE (title LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR (repo_owner || '/' || repo_name) LIKE ? ESCAPE '\\' OR EXISTS ( SELECT 1 FROM session_repositories sr WHERE sr.session_id = sessions.id AND (sr.repo_owner || '/' || sr.repo_name) LIKE ? ESCAPE '\\' ))"
    );
    expect(params).toEqual([
      "%50\\%\\_off\\\\%",
      "50\\%\\_off\\\\%",
      "%50\\%\\_off\\\\%",
      "%50\\%\\_off\\\\%",
    ]);
  });
});
