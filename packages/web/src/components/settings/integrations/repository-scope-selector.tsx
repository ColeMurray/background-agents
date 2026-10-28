import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioCard } from "@/components/ui/form-controls";

type RepositoryScopeMode = "all" | "selected";

export function RepositoryScopeSelector({
  name,
  mode,
  onModeChange,
  availableRepos,
  enabledRepos,
  onToggleRepo,
  allRepositoriesDescription,
  selectedRepositoriesDescription,
  emptySelectionWarning,
}: {
  name: string;
  mode: RepositoryScopeMode;
  onModeChange: (mode: RepositoryScopeMode) => void;
  availableRepos: EnrichedRepository[];
  enabledRepos: string[];
  onToggleRepo: (fullName: string) => void;
  allRepositoriesDescription: string;
  selectedRepositoriesDescription: string;
  emptySelectionWarning: string;
}) {
  return (
    <div className="mb-4">
      <p className="text-sm font-medium text-foreground mb-2">Repository Scope</p>
      <div className="grid sm:grid-cols-2 gap-2 mb-3">
        <RadioCard
          name={name}
          checked={mode === "all"}
          onChange={() => onModeChange("all")}
          label="All repositories"
          description={allRepositoriesDescription}
        />
        <RadioCard
          name={name}
          checked={mode === "selected"}
          onChange={() => onModeChange("selected")}
          label="Selected repositories"
          description={selectedRepositoriesDescription}
        />
      </div>

      {mode === "selected" && (
        <>
          {availableRepos.length === 0 ? (
            <p className="text-sm text-muted-foreground px-4 py-3 border border-border rounded-sm">
              Repository filtering is unavailable because no repositories are accessible.
            </p>
          ) : (
            <div className="border border-border max-h-56 overflow-y-auto rounded-sm">
              {availableRepos.map((repo) => {
                const fullName = repo.fullName.toLowerCase();
                const isChecked = enabledRepos.includes(fullName);

                return (
                  <label
                    key={repo.fullName}
                    className="flex items-center gap-2 px-4 py-2 hover:bg-muted/50 transition cursor-pointer text-sm"
                  >
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => onToggleRepo(repo.fullName)}
                    />
                    <span className="text-foreground">{repo.fullName}</span>
                  </label>
                );
              })}
            </div>
          )}

          {enabledRepos.length === 0 && availableRepos.length > 0 && (
            <p className="text-xs text-warning mt-1">{emptySelectionWarning}</p>
          )}
        </>
      )}
    </div>
  );
}
