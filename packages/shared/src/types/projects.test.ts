import { describe, expect, it } from "vitest";
import { permissionsForBuiltInRole } from "../rbac";
import type { SessionViewer } from "./session-access";
import { projectCapabilities, projectSourceInputSchema } from "./projects";
const viewer = (
  role: "member" | "viewer" | "administrator",
  teamRole?: "member" | "lead"
): SessionViewer => ({
  kind: "user",
  userId: "u",
  roleKey: role,
  permissions: permissionsForBuiltInRole(role),
  suspended: false,
  memberships: new Map(teamRole ? [["team_a", teamRole]] : []),
});
describe("project access", () => {
  it("hides a former creator's team project after membership removal", () => {
    expect(
      projectCapabilities(viewer("member"), { ownerTeamId: "team_a", ownerUserId: "u" }).canRead
    ).toBe(false);
  });
  it("allows creator and lead edits, not unrelated members or viewers", () => {
    const project = { ownerTeamId: "team_a", ownerUserId: "other" };
    expect(projectCapabilities(viewer("member", "member"), project).canEditMetadata).toBe(false);
    expect(projectCapabilities(viewer("member", "lead"), project).canEditMetadata).toBe(true);
    expect(projectCapabilities(viewer("viewer", "lead"), project).canEditMetadata).toBe(false);
    expect(projectCapabilities(viewer("administrator"), project).canEditMetadata).toBe(true);
  });
  it("allows workspace reads and denies suspended viewers", () => {
    expect(
      projectCapabilities(viewer("viewer"), { ownerTeamId: null, ownerUserId: "other" }).canRead
    ).toBe(true);
    const user = viewer("administrator");
    if (user.kind === "user") user.suspended = true;
    expect(projectCapabilities(user, { ownerTeamId: null, ownerUserId: "u" }).canRead).toBe(false);
  });
});

it("keeps repository document references inside a relative checkout path", () => {
  const source = {
    sourceType: "repo_doc",
    role: "reference",
    externalIdOrUrl: "group/subgroup/app:docs/plan.md",
  };
  expect(projectSourceInputSchema.safeParse(source).success).toBe(true);
  for (const path of ["../secret", "/etc/passwd", "docs/../../secret", "docs//plan"])
    expect(
      projectSourceInputSchema.safeParse({
        ...source,
        externalIdOrUrl: `group/subgroup/app:${path}`,
      }).success
    ).toBe(false);
});
