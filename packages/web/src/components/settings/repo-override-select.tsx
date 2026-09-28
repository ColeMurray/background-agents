import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface RepoOverrideSelectProps {
  repositories: EnrichedRepository[];
  value: string;
  onValueChange: (value: string) => void;
  onAdd: () => void;
  ariaLabel?: string;
}

export function RepoOverrideSelect({
  repositories,
  value,
  onValueChange,
  onAdd,
  ariaLabel,
}: RepoOverrideSelectProps) {
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
