import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface RepoOverrideAddControlProps {
  availableRepos: EnrichedRepository[];
  value: string;
  onValueChange: (value: string) => void;
  onAdd: () => void;
}

export function RepoOverrideAddControl({
  availableRepos,
  value,
  onValueChange,
  onAdd,
}: RepoOverrideAddControlProps) {
  return (
    <div className="flex items-center gap-2">
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="flex-1" aria-label="Select a repository">
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
