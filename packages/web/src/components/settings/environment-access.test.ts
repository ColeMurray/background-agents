import { describe, expect, it } from "vitest";
import type { Environment } from "@open-inspect/shared/types/environments";
import { environmentAccess, type EnvironmentFeatureGrants } from "./environment-access";

const allGrants: EnvironmentFeatureGrants = {
  manageSecrets: true,
  manageRepoSecrets: true,
  manageSettings: true,
  manageImages: true,
  readImages: true,
  readSettings: true,
};

function environment(capabilities?: Environment["capabilities"]): Environment {
  return {
    id: "env-1",
    name: "Stack",
    description: null,
    prebuildEnabled: true,
    createdAt: 1,
    updatedAt: 1,
    repositories: [],
    capabilities,
  };
}

describe("environmentAccess", () => {
  it("grants nothing without server capabilities, whatever the feature grants", () => {
    expect(environmentAccess(environment(), allGrants)).toEqual({
      canManage: false,
      canEditSecrets: false,
      canImportRepoSecrets: false,
      canEditOverrides: false,
      canViewImage: false,
      canRebuild: false,
      tabs: [],
    });
  });

  it("lets readers view secrets and overrides without editing them", () => {
    const access = environmentAccess(
      environment({ canRead: true, canManage: false, canUse: true }),
      allGrants
    );
    expect(access.tabs).toEqual(["secrets", "overrides"]);
    expect(access).toMatchObject({ canEditSecrets: false, canEditOverrides: false });
    expect(access.canViewImage).toBe(true);
  });

  it("requires the feature grant alongside environment management", () => {
    const access = environmentAccess(
      environment({ canRead: true, canManage: true, canUse: true }),
      { ...allGrants, manageSecrets: false, manageImages: false }
    );
    expect(access.tabs).toEqual(["configuration", "overrides"]);
    expect(access).toMatchObject({
      canManage: true,
      canEditSecrets: false,
      canImportRepoSecrets: false,
      canRebuild: false,
      canEditOverrides: true,
    });
  });
});
