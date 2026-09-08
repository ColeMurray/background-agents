import { RepositoryPairValidationError } from "@open-inspect/shared";
import { describe, expect, it } from "vitest";
import type { SessionRepositoryRow } from "./repository";
import {
  AmbiguousRepositoryTargetError,
  buildSessionRepositories,
  mapRepositoryTargetError,
  RepositoryNotMemberError,
  resolveSessionRepositoryTarget,
} from "./repository-target";

function createRow(
  position: number,
  repoOwner: string,
  repoName: string,
  overrides: Partial<SessionRepositoryRow> = {}
): SessionRepositoryRow {
  return {
    position,
    repo_owner: repoOwner,
    repo_name: repoName,
    repo_id: position + 1,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    ...overrides,
  };
}

const SCALAR = { repoOwner: "acme", repoName: "web" };

describe("buildSessionRepositories", () => {
  it("synthesizes a sole primary member from the scalar mirror when no rows exist", () => {
    expect(buildSessionRepositories({ ...SCALAR, baseBranch: "develop" }, [])).toEqual([
      {
        repoOwner: "acme",
        repoName: "web",
        position: 0,
        baseBranch: "develop",
        isPrimary: true,
        row: null,
      },
    ]);
  });

  it("leaves the synthesized base branch null when the scalar mirror has none", () => {
    expect(buildSessionRepositories(SCALAR, [])[0].baseBranch).toBeNull();
  });

  it("takes each entry's base branch from its row", () => {
    const members = buildSessionRepositories({ ...SCALAR, baseBranch: "ignored" }, [
      createRow(0, "acme", "web"),
      createRow(1, "acme", "backend", { base_branch: "develop" }),
    ]);

    expect(members.map((member) => member.baseBranch)).toEqual(["main", "develop"]);
  });

  it("maps rows and marks the scalar-mirror member primary", () => {
    const rows = [createRow(0, "acme", "web"), createRow(1, "acme", "backend")];

    const members = buildSessionRepositories(SCALAR, rows);

    expect(members).toHaveLength(2);
    expect(members[0]).toMatchObject({ repoOwner: "acme", repoName: "web", isPrimary: true });
    expect(members[0].row).toBe(rows[0]);
    expect(members[1]).toMatchObject({ repoOwner: "acme", repoName: "backend", isPrimary: false });
  });

  it("marks primary by scalar identity, case-insensitively, not by position", () => {
    const members = buildSessionRepositories({ repoOwner: "Acme", repoName: "Backend" }, [
      createRow(0, "acme", "web"),
      createRow(1, "acme", "backend"),
    ]);

    expect(members.map((member) => member.isPrimary)).toEqual([false, true]);
  });
});

describe("resolveSessionRepositoryTarget", () => {
  const members = buildSessionRepositories(SCALAR, [
    createRow(0, "acme", "web"),
    createRow(1, "acme", "backend"),
  ]);

  it("returns the sole member when no repo is requested", () => {
    const sole = buildSessionRepositories(SCALAR, []);

    expect(resolveSessionRepositoryTarget({}, sole)).toBe(sole[0]);
  });

  it("throws AmbiguousRepositoryTargetError listing members when no repo is requested", () => {
    expect(() => resolveSessionRepositoryTarget({}, members)).toThrow(
      new AmbiguousRepositoryTargetError(members)
    );
    expect(() => resolveSessionRepositoryTarget({}, members)).toThrow(
      "This session spans multiple repositories — specify repoOwner and repoName (one of: acme/web, acme/backend)"
    );
  });

  it("propagates RepositoryPairValidationError for a half-specified pair", () => {
    expect(() => resolveSessionRepositoryTarget({ repoOwner: "acme" }, members)).toThrow(
      RepositoryPairValidationError
    );
  });

  it("matches case-insensitively and returns the member with canonical casing", () => {
    const target = resolveSessionRepositoryTarget(
      { repoOwner: "Acme", repoName: "Backend" },
      members
    );

    expect(target).toBe(members[1]);
  });

  it("throws RepositoryNotMemberError for a repo outside the session", () => {
    expect(() =>
      resolveSessionRepositoryTarget({ repoOwner: "evil", repoName: "exfil" }, members)
    ).toThrow("Repository evil/exfil is not part of this session");
    expect(() =>
      resolveSessionRepositoryTarget({ repoOwner: "evil", repoName: "exfil" }, members)
    ).toThrow(RepositoryNotMemberError);
  });

  it("rejects an empty member list as a caller contract violation", () => {
    expect(() => resolveSessionRepositoryTarget({}, [])).toThrow(
      "Session has no member repositories"
    );
  });
});

describe("mapRepositoryTargetError", () => {
  const members = buildSessionRepositories(SCALAR, []);

  it("maps non-membership to 403", () => {
    expect(
      mapRepositoryTargetError(new RepositoryNotMemberError({ repoOwner: "evil", repoName: "x" }))
    ).toEqual({ status: 403, error: "Repository evil/x is not part of this session" });
  });

  it("maps ambiguous and half-specified targets to 400", () => {
    expect(mapRepositoryTargetError(new AmbiguousRepositoryTargetError(members))?.status).toBe(400);
    expect(mapRepositoryTargetError(new RepositoryPairValidationError("half"))).toEqual({
      status: 400,
      error: "half",
    });
  });

  it("returns null for unrelated errors so callers rethrow", () => {
    expect(mapRepositoryTargetError(new Error("boom"))).toBeNull();
  });
});
