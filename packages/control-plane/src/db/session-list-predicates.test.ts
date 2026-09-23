import { describe, expect, it } from "vitest";
import { buildSessionListPredicates } from "./session-list-predicates";

const collapse = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("buildSessionListPredicates", () => {
  it("returns no clause for an unfiltered list", () => {
    expect(buildSessionListPredicates({})).toEqual({ where: "", params: [] });
  });

  it("binds each filter in clause order", () => {
    const { where, params } = buildSessionListPredicates({
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

  it("matches a repository through the scalar primary or any member row", () => {
    const { where, params } = buildSessionListPredicates({
      repository: { repoOwner: "Acme", repoName: "Web-App" },
    });
    expect(collapse(where)).toContain(
      "LOWER(repo_owner) = LOWER(?) AND LOWER(repo_name) = LOWER(?)"
    );
    expect(collapse(where)).toContain("EXISTS ( SELECT 1 FROM session_repositories sr");
    expect(params).toEqual(["Acme", "Web-App", "Acme", "Web-App"]);
  });

  it("binds escaped LIKE patterns for title, id prefix, and repository labels", () => {
    const { where, params } = buildSessionListPredicates({ search: "50%_off\\" });
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
