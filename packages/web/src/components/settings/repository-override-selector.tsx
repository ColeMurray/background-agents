"use client";

import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface RepositoryOverrideSelectorProps {
  repositories: EnrichedRepository[];
  value: string;
  onValueChange: (value: string) => void;
  onAdd: () => void;
}

export function RepositoryOverrideSelector({
  repositories,
  value,
  onValueChange,
  onAdd,
}: RepositoryOverrideSelectorProps) {
  return (
    <div className="flex items-center gap-2">
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="flex-1" aria-label="Select a repository">
          <SelectValue placeholder="Select a repository..." />
        </SelectTrigger>
        <SelectContent>
          {repositories.map((repository) => (
            <SelectItem key={repository.fullName} value={repository.fullName.toLowerCase()}>
              {repository.fullName}
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
