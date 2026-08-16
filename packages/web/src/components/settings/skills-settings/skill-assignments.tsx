import type { Environment } from "@open-inspect/shared/types/environments";
import type { SkillAssignmentInput } from "@open-inspect/shared/types/skills";
import type { Repo } from "@/hooks/use-repos";
import { ScopeCheckbox } from "./shared";

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

export function SkillAssignments({
  assignmentKeys,
  repos,
  environments,
  onToggle,
}: {
  assignmentKeys: Set<string>;
  repos: Repo[];
  environments: Environment[];
  onToggle: (key: string, checked: boolean) => void;
}) {
  return (
    <div className="rounded border border-border-muted p-4">
      <h4 className="text-sm font-medium text-foreground">Assignments</h4>
      <p className="mb-3 text-xs text-muted-foreground">
        A skill applies when any assignment matches the session target.
      </p>
      <div className="space-y-3">
        <ScopeCheckbox
          checked={assignmentKeys.has("global")}
          onChange={(value) => onToggle("global", value)}
        >
          All sessions (global)
        </ScopeCheckbox>
        {repos.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Repositories
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {repos.map((repo) => {
                const key = `repository:${repo.owner}/${repo.name}`;
                return (
                  <ScopeCheckbox
                    key={repo.fullName}
                    checked={assignmentKeys.has(key)}
                    onChange={(value) => onToggle(key, value)}
                  >
                    {repo.fullName}
                  </ScopeCheckbox>
                );
              })}
            </div>
          </div>
        )}
        {environments.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Environments
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {environments.map((environment) => {
                const key = `environment:${environment.id}`;
                return (
                  <ScopeCheckbox
                    key={environment.id}
                    checked={assignmentKeys.has(key)}
                    onChange={(value) => onToggle(key, value)}
                  >
                    {environment.name}
                  </ScopeCheckbox>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
