import {
  encodeRepositoryPathSegments,
  parseRepositoryFullName,
} from "@open-inspect/shared/types/repositories";

export const SCM_REPO_SETTINGS_KEY = "/api/scm-settings/repos";

export function getScmRepoSettingsPath(fullName: string): `/api/${string}` | null {
  const repository = parseRepositoryFullName(fullName);
  return repository ? `${SCM_REPO_SETTINGS_KEY}/${encodeRepositoryPathSegments(repository)}` : null;
}
