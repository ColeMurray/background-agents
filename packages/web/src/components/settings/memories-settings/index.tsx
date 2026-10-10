"use client";

import { useId, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  memoryScopeFromSearchParams,
  memoryScopeDisplayKey,
  type MemoryScope,
} from "@open-inspect/shared/types/memories";
import { setMemoryPreferences, useMemoryPreferences } from "@/hooks/use-memories";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useRepos } from "@/hooks/use-repos";
import { useEnvironments } from "@/hooks/use-environments";
import { errorMessage, PERSONAL_MEMORY_DISCLOSURE } from "@/lib/memories";
import { Switch } from "@/components/ui/switch";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { ChevronDownIcon } from "@/components/ui/icons";
import { MemoryCollection } from "./memory-collection";

/** Persist the account-wide default and disclose the audience of included personal context. */
function PersonalMemoryDefault() {
  const switchId = useId();
  const { preferences, error: loadError, mutate } = useMemoryPreferences();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  async function save(includePersonalMemories: boolean) {
    setSaving(true);
    setSaveError("");
    try {
      await mutate(await setMemoryPreferences({ includePersonalMemories }), false);
    } catch (cause) {
      setSaveError(errorMessage(cause, "Save failed"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-2 rounded-sm border border-border p-4">
      <div className="flex items-center gap-2 text-sm">
        <Switch
          id={switchId}
          checked={preferences?.includePersonalMemories ?? false}
          disabled={!preferences || saving}
          onCheckedChange={(checked) => void save(checked)}
        />
        <label htmlFor={switchId}>Include my personal memories in new sessions</label>
      </div>
      <p className="text-xs text-muted-foreground">
        Applies to all new web, integration-created and scheduled sessions. Existing sessions keep
        their original selection.
      </p>
      <p className="text-xs text-muted-foreground">{PERSONAL_MEMORY_DISCLOSURE}</p>
      {(saveError || loadError) && (
        <p role="alert" className="text-sm text-destructive">
          {saveError || "Could not load memory preferences."}
        </p>
      )}
    </div>
  );
}

/**
 * Combine owner-only memory management with the future-session inclusion default. The default is
 * available to every session creator; only the catalog requires `memories.manage_own`.
 */
export function MemoriesSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Memories</h2>
        <p className="text-sm text-muted-foreground">
          Personal directives are your custom instructions. Facts preserve useful knowledge across
          sessions.
        </p>
      </div>
      <PersonalMemoryDefault />
      {hasPermission("memories.manage_own") && <MemoryCollection scope={{ type: "personal" }} />}
    </section>
  );
}

/** Select an accessible repository/environment; management capabilities come from the API. */
export function SharedMemoriesSettings() {
  const params = useSearchParams();
  const { repos, loading: reposLoading, error: reposError } = useRepos();
  const {
    environments,
    loading: environmentsLoading,
    error: environmentsError,
  } = useEnvironments();
  const [selection, setSelection] = useState<MemoryScope | null>(null);
  const linkedScope = memoryScopeFromSearchParams(params);
  const scope = selection ?? (linkedScope?.type === "personal" ? null : linkedScope);
  const options: { scope: MemoryScope; label: string }[] = [
    ...repos.map((repo) => ({
      scope: { type: "repository", repoOwner: repo.owner, repoName: repo.name } as const,
      label: repo.fullName,
    })),
    ...environments.map((environment) => ({
      scope: { type: "environment", environmentId: environment.id } as const,
      label: environment.name,
    })),
  ];
  // Searchable and grouped, like the repository picker in Secrets: deployments can have many repos.
  const groups: ComboboxGroup[] = [
    { category: "Repositories", type: "repository" },
    { category: "Environments", type: "environment" },
  ]
    .map(({ category, type }) => ({
      category,
      options: options
        .filter((option) => option.scope.type === type)
        .map((option) => ({ value: memoryScopeDisplayKey(option.scope), label: option.label })),
    }))
    .filter((group) => group.options.length > 0);
  const selectedKey = scope ? memoryScopeDisplayKey(scope) : "";
  const selectedLabel = options.find(
    (option) => memoryScopeDisplayKey(option.scope) === selectedKey
  )?.label;
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Shared memories</h2>
        <p className="text-sm text-muted-foreground">
          Curate repository and environment knowledge. Agent proposals require approval before other
          sessions load them.
        </p>
      </div>
      <div>
        <label
          id="shared-memory-scope-label"
          htmlFor="shared-memory-scope"
          className="mb-1.5 block text-sm font-medium text-foreground"
        >
          Memory scope
        </label>
        <Combobox
          id="shared-memory-scope"
          labelId="shared-memory-scope-label"
          value={selectedKey}
          onChange={(key) =>
            setSelection(
              options.find((option) => memoryScopeDisplayKey(option.scope) === key)?.scope ?? null
            )
          }
          items={groups}
          searchable
          searchPlaceholder="Search repositories and environments..."
          filterFn={(option, query) => option.label.toLowerCase().includes(query)}
          direction="down"
          dropdownWidth="w-full max-w-sm"
          triggerClassName="w-full max-w-sm flex items-center justify-between px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <span className={`truncate ${selectedLabel ? "" : "text-muted-foreground"}`}>
            {selectedLabel ?? "Choose a repository or environment"}
          </span>
          <ChevronDownIcon className="h-3 w-3 flex-shrink-0" />
        </Combobox>
      </div>
      {(reposLoading || environmentsLoading) && <p className="text-sm">Loading scopes…</p>}
      {(reposError || environmentsError) && (
        <p role="alert" className="text-sm text-destructive">
          Some memory scopes could not be loaded.
        </p>
      )}
      {scope ? (
        <MemoryCollection key={memoryScopeDisplayKey(scope)} scope={scope} />
      ) : (
        <p className="text-sm text-muted-foreground">Select a scope to view its memories.</p>
      )}
    </section>
  );
}
