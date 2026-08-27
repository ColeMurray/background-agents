import type { Environment } from "@open-inspect/shared/types/environments";
import type { Repo } from "@/hooks/use-repos";
import { ScopeCheckbox } from "./shared";

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
