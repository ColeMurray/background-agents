"use client";

import { useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import type { EnvironmentRepository } from "@open-inspect/shared";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { RepoIcon, ChevronDownIcon } from "@/components/ui/icons";

interface RepoSecretsResponse {
  secrets: { key: string }[];
}

/**
 * Per-key import of a repository's secrets into an environment (design §7.4).
 * The source must be one of the environment's repositories (the control plane
 * rejects other sources); values are copied server-side and never displayed.
 * Imports are copies — they don't follow later rotations of the repo secret.
 */
export function EnvironmentSecretsImport({
  environmentId,
  repositories,
  disabled = false,
}: {
  environmentId: string;
  repositories: EnvironmentRepository[];
  disabled?: boolean;
}) {
  const [sourceKey, setSourceKey] = useState("");
  const [selectedSecretKeys, setSelectedSecretKeys] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const source = useMemo(
    () =>
      repositories.find(
        (repository) => `${repository.repoOwner}/${repository.repoName}` === sourceKey
      ) ?? null,
    [repositories, sourceKey]
  );

  const { data, isLoading } = useSWR<RepoSecretsResponse>(
    source ? `/api/repos/${source.repoOwner}/${source.repoName}/secrets` : null
  );
  const sourceSecretKeys = data?.secrets?.map((secret) => secret.key) ?? [];

  const handleSourceChange = (value: string) => {
    setSourceKey(value);
    setSelectedSecretKeys(new Set());
  };

  const toggleSecretKey = (key: string) => {
    setSelectedSecretKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleImport = async () => {
    if (!source || selectedSecretKeys.size === 0) return;
    setImporting(true);

    try {
      const response = await fetch(`/api/environments/${environmentId}/secrets/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoOwner: source.repoOwner,
          repoName: source.repoName,
          keys: [...selectedSecretKeys],
        }),
      });
      const result = await response.json();

      if (!response.ok) {
        toast.error(result?.error || "Failed to import secrets");
        return;
      }

      const count = Array.isArray(result?.keys) ? result.keys.length : selectedSecretKeys.size;
      toast.success(`Imported ${count} secret${count === 1 ? "" : "s"}`);
      setSelectedSecretKeys(new Set());
      mutate(`/api/environments/${environmentId}/secrets`);
    } catch {
      toast.error("Failed to import secrets");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="mt-4 rounded-md border border-border bg-background p-4">
      <h3 className="text-sm font-semibold text-foreground">Import from a repository</h3>
      <p className="text-xs text-muted-foreground mb-3">
        Copy secrets from one of this environment&apos;s repositories. Values are copied server-side
        and never shown; later changes to the repository secret do not carry over.
      </p>

      <Combobox
        value={sourceKey}
        onChange={handleSourceChange}
        items={repositories.map((repository) => ({
          value: `${repository.repoOwner}/${repository.repoName}`,
          label: `${repository.repoOwner}/${repository.repoName}`,
        }))}
        dropdownWidth="w-72"
        disabled={disabled || importing}
        triggerClassName="flex items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
      >
        <RepoIcon className="w-4 h-4 text-muted-foreground" />
        <span className="truncate flex-1 text-left">{sourceKey || "Select source repository"}</span>
        <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
      </Combobox>

      {source && (
        <div className="mt-3">
          {isLoading && <p className="text-xs text-muted-foreground">Loading secret keys...</p>}
          {!isLoading && sourceSecretKeys.length === 0 && (
            <p className="text-xs text-muted-foreground">No secrets set on {sourceKey}.</p>
          )}
          {sourceSecretKeys.length > 0 && (
            <>
              <div className="space-y-1">
                {sourceSecretKeys.map((key) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={selectedSecretKeys.has(key)}
                      onChange={() => toggleSecretKey(key)}
                      disabled={disabled || importing}
                      className="h-4 w-4 rounded border-border accent-accent"
                    />
                    <span className="font-mono text-xs">{key}</span>
                  </label>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="mt-3"
                onClick={handleImport}
                disabled={disabled || importing || selectedSecretKeys.size === 0}
              >
                {importing
                  ? "Importing..."
                  : `Import ${selectedSecretKeys.size || ""} selected`.trim()}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
