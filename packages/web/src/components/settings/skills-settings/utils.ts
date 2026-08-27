import type { Environment } from "@open-inspect/shared/types/environments";
import type {
  SkillAssignmentInput,
  SkillImportPreviewResponse,
} from "@open-inspect/shared/types/skills";
import type { Repo } from "@/hooks/use-repos";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export function assignmentKey(assignment: SkillAssignmentInput): string {
  if (assignment.type === "global") return "global";
  if (assignment.type === "environment") return `environment:${assignment.environmentId}`;
  return `repository:${assignment.repository.repoOwner}/${assignment.repository.repoName}`;
}

export function buildAssignments(
  assignmentKeys: Set<string>,
  repos: Repo[],
  environments: Environment[],
  initialAssignments: SkillAssignmentInput[]
): SkillAssignmentInput[] {
  const result: SkillAssignmentInput[] = [];
  if (assignmentKeys.has("global")) result.push({ type: "global" });
  for (const repo of repos) {
    if (assignmentKeys.has(`repository:${repo.owner}/${repo.name}`)) {
      result.push({
        type: "repository",
        repository: { repoOwner: repo.owner, repoName: repo.name, baseBranch: null },
      });
    }
  }
  for (const environment of environments) {
    if (assignmentKeys.has(`environment:${environment.id}`)) {
      result.push({ type: "environment", environmentId: environment.id });
    }
  }
  // Preserve selected scopes absent from the latest lookups; listing failure,
  // permission changes, or catalog drift must not make an unrelated save delete them.
  for (const assignment of initialAssignments) {
    if (
      assignmentKeys.has(assignmentKey(assignment)) &&
      !result.some((item) => assignmentKey(item) === assignmentKey(assignment))
    ) {
      result.push(assignment);
    }
  }
  return result;
}

/**
 * The confirmation an import sends back with the previewed source. Both the
 * import and re-import flows go through here so they cannot disagree about
 * what "store exactly what was reviewed" means.
 */
export function previewedSourceConfirmation(preview: SkillImportPreviewResponse): {
  expectedCommitSha: string;
  expectedSourceSha256: string;
  expectedRevisionSha256: string;
} {
  return {
    expectedCommitSha: preview.source.commitSha,
    expectedSourceSha256: preview.source.sourceSha256,
    expectedRevisionSha256: preview.revisionSha256,
  };
}
