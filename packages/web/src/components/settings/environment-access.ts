import type { Environment } from "@open-inspect/shared/types/environments";

export type EnvironmentTab = "configuration" | "secrets" | "overrides";

/** Workspace feature grants that environment actions require on top of environment access. */
export interface EnvironmentFeatureGrants {
  manageSecrets: boolean;
  manageRepoSecrets: boolean;
  manageSettings: boolean;
  manageImages: boolean;
  readImages: boolean;
  readSettings: boolean;
}

export interface EnvironmentAccess {
  canManage: boolean;
  canEditSecrets: boolean;
  canImportRepoSecrets: boolean;
  canEditOverrides: boolean;
  canViewImage: boolean;
  canRebuild: boolean;
  /** Detail tabs the viewer may open, in display order; empty means no detail view. */
  tabs: EnvironmentTab[];
}

/**
 * What the viewer may do with one environment: the server's capabilities for that environment
 * combined with the feature grant each action also needs. Missing capabilities grant nothing.
 */
export function environmentAccess(
  environment: Environment,
  grants: EnvironmentFeatureGrants
): EnvironmentAccess {
  const canManage = environment.capabilities?.canManage === true;
  const canRead = environment.capabilities?.canRead === true;
  const tabs: EnvironmentTab[] = [];
  if (canManage) tabs.push("configuration");
  if (canRead && grants.manageSecrets) tabs.push("secrets");
  if (canRead && grants.readSettings) tabs.push("overrides");
  return {
    canManage,
    canEditSecrets: canManage && grants.manageSecrets,
    canImportRepoSecrets: canManage && grants.manageSecrets && grants.manageRepoSecrets,
    canEditOverrides: canManage && grants.manageSettings,
    canViewImage: canRead && grants.readImages,
    canRebuild: canManage && grants.manageImages,
    tabs,
  };
}
