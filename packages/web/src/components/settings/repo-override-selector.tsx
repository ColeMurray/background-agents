import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface RepoOverrideSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  repositories: EnrichedRepository[];
  onAdd: () => void;
  ariaLabel?: string;
}

export function RepoOverrideSelector({
  value,
  onValueChange,
  repositories,
  onAdd,
  ariaLabel,
}: RepoOverrideSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="flex-1" aria-label={ariaLabel}>
          <SelectValue placeholder="Select a repository..." />
        </SelectTrigger>
        <SelectContent>
          {repositories.map((repo) => (
            <SelectItem key={repo.fullName} value={repo.fullName.toLowerCase()}>
              {repo.fullName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button onClick={onAdd} disabled={!value}>
        Add Override
      </Button>
    </div>
  );
}
