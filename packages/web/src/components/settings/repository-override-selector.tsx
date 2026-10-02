"use client";

import { useState } from "react";
import { parseRepositoryFullName } from "@open-inspect/shared/types/repositories";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { repositorySelectionKey } from "@/lib/repository-selection";

interface RepositoryIdentity {
  fullName: string;
}

interface RepositoryOverrideSelectorProps {
  repositories: RepositoryIdentity[];
  overriddenRepositories: string[];
  onAdd: (repositoryKey: string) => Promise<boolean>;
}

export function RepositoryOverrideSelector({
  repositories,
  overriddenRepositories,
  onAdd,
}: RepositoryOverrideSelectorProps) {
  const [selectedRepository, setSelectedRepository] = useState("");
  const overriddenKeys = new Set(
    overriddenRepositories.map((repository) => repository.toLowerCase())
  );
  const availableRepositories = repositories.flatMap((repository) => {
    const parsed = parseRepositoryFullName(repository.fullName);
    if (!parsed) return [];
    const key = repositorySelectionKey(parsed.repoOwner, parsed.repoName);
    return overriddenKeys.has(key) ? [] : [{ key, label: repository.fullName }];
  });

  const handleAdd = async () => {
    if (selectedRepository && (await onAdd(selectedRepository))) {
      setSelectedRepository("");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Select value={selectedRepository} onValueChange={setSelectedRepository}>
        <SelectTrigger className="flex-1" aria-label="Select a repository">
          <SelectValue placeholder="Select a repository..." />
        </SelectTrigger>
        <SelectContent>
          {availableRepositories.map((repository) => (
            <SelectItem key={repository.key} value={repository.key}>
              {repository.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button onClick={handleAdd} disabled={!selectedRepository}>
        Add Override
      </Button>
    </div>
  );
}
