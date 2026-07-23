"use client";

import { useCallback, useMemo, useState } from "react";
import {
  MAX_ENVIRONMENT_NAME_LENGTH,
  MAX_ENVIRONMENT_DESCRIPTION_LENGTH,
  parseRepositoryFullName,
  type Environment,
  type RepositoryInput,
} from "@open-inspect/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { BranchIcon, ChevronDownIcon, RepoIcon } from "@/components/ui/icons";
import { useBranches } from "@/hooks/use-branches";
import { useRepos, type Repo } from "@/hooks/use-repos";
import {
  RepositoryMultiSelect,
  repositorySelectionKey,
} from "@/components/repository-multi-select";
import { supportsRepoImages } from "@/lib/sandbox-provider";

export interface EnvironmentFormValues {
  name: string;
  description: string | null;
  prebuildEnabled: boolean;
  repositories: RepositoryInput[];
}

/**
 * Create/edit form for an environment: name, description, the ordered
 * repository list ([0] = primary) with a per-repository base branch, and the
 * prebuild toggle. Repositories keep their selection order; rows can be
 * reordered so any repository can become the primary (the sandbox/settings
 * source).
 */
export function EnvironmentForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  submitting,
}: {
  mode: "create" | "edit";
  initialValues?: Environment;
  onSubmit: (values: EnvironmentFormValues) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const { repos, loading: loadingRepos } = useRepos();
  const prebuildsSupported = supportsRepoImages();

  const [name, setName] = useState(initialValues?.name ?? "");
  const [description, setDescription] = useState(initialValues?.description ?? "");
  const [prebuildEnabled, setPrebuildEnabled] = useState(initialValues?.prebuildEnabled ?? false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() =>
    (initialValues?.repositories ?? []).map((repository) =>
      repositorySelectionKey(repository.repoOwner, repository.repoName)
    )
  );
  const [branchByKey, setBranchByKey] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (initialValues?.repositories ?? []).map((repository) => [
        repositorySelectionKey(repository.repoOwner, repository.repoName),
        repository.baseBranch,
      ])
    )
  );

  const repoByKey = useMemo(() => {
    const byKey = new Map<string, Repo>();
    for (const repo of repos) {
      byKey.set(repositorySelectionKey(repo.owner, repo.name), repo);
    }
    return byKey;
  }, [repos]);

  const handleSelectionChange = useCallback(
    (next: string[]) => {
      setSelectedKeys(next);
      setBranchByKey((current) => {
        const updated = { ...current };
        for (const key of next) {
          if (updated[key] === undefined) {
            updated[key] = repoByKey.get(key)?.defaultBranch ?? "";
          }
        }
        return updated;
      });
    },
    [repoByKey]
  );

  const moveRepository = (index: number, delta: -1 | 1) => {
    setSelectedKeys((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const removeRepository = (key: string) => {
    setSelectedKeys((current) => current.filter((entry) => entry !== key));
  };

  const canSubmit = name.trim().length > 0 && selectedKeys.length > 0 && !submitting;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      prebuildEnabled,
      repositories: selectedKeys.map((key) => {
        const entry: RepositoryInput = parseRepositoryFullName(key) ?? {
          repoOwner: "",
          repoName: "",
        };
        const branch = branchByKey[key]?.trim();
        if (branch) entry.baseBranch = branch;
        return entry;
      }),
    });
  };

  const triggerLabel =
    selectedKeys.length === 0
      ? "Select repositories"
      : selectedKeys.length === 1
        ? selectedKeys[0]
        : `${selectedKeys.length} repositories`;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="environment-name"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Name
        </label>
        <Input
          id="environment-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="full-stack"
          maxLength={MAX_ENVIRONMENT_NAME_LENGTH}
          required
        />
      </div>

      <div>
        <label
          htmlFor="environment-description"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Description
        </label>
        <Input
          id="environment-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Frontend + backend for the main app (optional)"
          maxLength={MAX_ENVIRONMENT_DESCRIPTION_LENGTH}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Repositories</label>
        <RepositoryMultiSelect
          repos={repos}
          loadingRepos={loadingRepos}
          selected={selectedKeys}
          onChange={handleSelectionChange}
          disabled={submitting}
          triggerLabel={triggerLabel}
          triggerClassName="w-full"
        />
        <p className="text-xs text-muted-foreground mt-1 leading-normal">
          Sessions clone every repository into one workspace. The first repository is the primary —
          it provides the sandbox and editor settings.
        </p>
      </div>

      {selectedKeys.length > 0 && (
        <div className="space-y-2">
          {selectedKeys.map((key, index) => (
            <EnvironmentRepositoryRow
              key={key}
              repositoryKey={key}
              isPrimary={index === 0}
              branch={branchByKey[key] ?? ""}
              onBranchChange={(branch) =>
                setBranchByKey((current) => ({ ...current, [key]: branch }))
              }
              canMoveUp={index > 0}
              canMoveDown={index < selectedKeys.length - 1}
              onMoveUp={() => moveRepository(index, -1)}
              onMoveDown={() => moveRepository(index, 1)}
              onRemove={() => removeRepository(key)}
              disabled={submitting}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        {prebuildsSupported ? (
          <>
            <Switch
              checked={prebuildEnabled}
              onCheckedChange={setPrebuildEnabled}
              disabled={submitting}
              aria-label="Toggle prebuilt images"
            />
            <div>
              <p className="text-sm font-medium text-foreground">Prebuild images</p>
              <p className="text-xs text-muted-foreground">
                Build an image with all repositories cloned and setup complete, so sessions start in
                seconds. Saving with prebuilds enabled starts a build.
              </p>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Prebuilt images are only available when <code>SANDBOX_PROVIDER=modal</code>,{" "}
            <code>vercel</code>, or <code>opencomputer</code>.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!canSubmit}>
          {submitting ? "Saving..." : mode === "create" ? "Create environment" : "Save environment"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * One ordered repository row: identity, primary badge, base-branch picker,
 * reorder and remove controls. A subcomponent so each row can call
 * useBranches for its own repository.
 */
function EnvironmentRepositoryRow({
  repositoryKey,
  isPrimary,
  branch,
  onBranchChange,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRemove,
  disabled,
}: {
  repositoryKey: string;
  isPrimary: boolean;
  branch: string;
  onBranchChange: (branch: string) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const repository = parseRepositoryFullName(repositoryKey);
  const { branches, loading: loadingBranches } = useBranches(
    repository?.repoOwner ?? "",
    repository?.repoName ?? ""
  );

  return (
    <div className="flex flex-wrap items-center gap-2 border border-border-muted px-3 py-2">
      <RepoIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={repositoryKey}>
        {repositoryKey}
      </span>
      {isPrimary && (
        <Badge variant="info" className="text-[10px]">
          primary
        </Badge>
      )}
      <Combobox
        value={branch}
        onChange={onBranchChange}
        items={branches.map((b) => ({ value: b.name, label: b.name }))}
        searchable
        searchPlaceholder="Search branches..."
        filterFn={(option, query) => option.label.toLowerCase().includes(query)}
        dropdownWidth="w-56"
        disabled={disabled || loadingBranches}
        triggerClassName="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        <BranchIcon className="w-3.5 h-3.5" />
        <span className="truncate max-w-[9rem]">
          {loadingBranches ? "Loading..." : branch || "branch"}
        </span>
        <ChevronDownIcon className="w-3 h-3" />
      </Combobox>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onMoveUp}
          disabled={disabled || !canMoveUp}
          aria-label={`Move ${repositoryKey} up`}
        >
          ↑
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onMoveDown}
          disabled={disabled || !canMoveDown}
          aria-label={`Move ${repositoryKey} down`}
        >
          ↓
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${repositoryKey}`}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}
