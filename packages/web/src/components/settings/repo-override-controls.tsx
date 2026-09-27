import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface RepoOverrideControlsProps {
  availableRepos: EnrichedRepository[];
  value: string;
  onValueChange: (value: string) => void;
  onAdd: () => void;
  triggerLabel?: string;
}

export function RepoOverrideControls({
  availableRepos,
  value,
  onValueChange,
  onAdd,
  triggerLabel,
}: RepoOverrideControlsProps) {
  return (
    <div className="flex items-center gap-2">
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="flex-1" aria-label={triggerLabel}>
          <SelectValue placeholder="Select a repository..." />
        </SelectTrigger>
        <SelectContent>
          {availableRepos.map((repo) => (
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
