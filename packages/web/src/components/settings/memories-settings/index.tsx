"use client";

import { useId, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  memoryScopeFromSearchParams,
  memoryScopeDisplayKey,
  type MemoryListScope,
  type MemoryScope,
} from "@open-inspect/shared/types/memories";
import { setMemoryPreferences, useMemoryPreferences } from "@/hooks/use-memories";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useRepos } from "@/hooks/use-repos";
import { useEnvironments } from "@/hooks/use-environments";
import { errorMessage, PERSONAL_MEMORY_DISCLOSURE } from "@/lib/memories";
import { Switch } from "@/components/ui/switch";
import {
  Combobox,
  FIELD_COMBOBOX_TRIGGER_CLASS,
  type ComboboxGroup,
} from "@/components/ui/combobox";
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

/** Browse all shared memories or one scope; management capabilities come from the API. */
export function SharedMemoriesSettings() {
  const params = useSearchParams();
  const { repos, loading: reposLoading, error: reposError } = useRepos();
  const {
    environments,
    loading: environmentsLoading,
    error: environmentsError,
  } = useEnvironments();
  const [selection, setSelection] = useState<MemoryListScope | null>(null);
  const linkedScope = memoryScopeFromSearchParams(params);
  const scope = selection ?? (linkedScope?.type === "personal" ? null : linkedScope) ?? "shared";
  // Searchable and grouped, like the repository picker in Secrets: deployments can have many repos.
  const scopeOptions = new Map<string, { scope: MemoryScope; label: string }>();
  const group = (category: string, entries: { scope: MemoryScope; label: string }[]) => ({
    category,
    options: entries.map((entry) => {
      const key = memoryScopeDisplayKey(entry.scope);
      scopeOptions.set(key, entry);
      return { value: key, label: entry.label };
    }),
  });
  const groups: ComboboxGroup[] = [
    { category: "Shared memories", options: [{ value: "shared", label: "All" }] },
    group(
      "Repositories",
      repos.map((repo) => ({
        scope: { type: "repository", repoOwner: repo.owner, repoName: repo.name },
        label: repo.fullName,
      }))
    ),
    group(
      "Environments",
      environments.map((environment) => ({
        scope: { type: "environment", environmentId: environment.id },
        label: environment.name,
      }))
    ),
  ].filter((entry) => entry.options.length > 0);
  const selectedKey = scope === "shared" ? "shared" : memoryScopeDisplayKey(scope);
  const selectedLabel = scope === "shared" ? "All" : scopeOptions.get(selectedKey)?.label;
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Shared memories</h2>
        <p className="text-sm text-muted-foreground">
          Curate repository and environment knowledge. Agent proposals require approval before other
          sessions load them. Choose Proposed to review pending memories across all accessible
          scopes.
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
            setSelection(key === "shared" ? "shared" : (scopeOptions.get(key)?.scope ?? null))
          }
          items={groups}
          searchable
          searchPlaceholder="Search repositories and environments..."
          direction="down"
          dropdownWidth="w-full max-w-sm"
          triggerClassName={FIELD_COMBOBOX_TRIGGER_CLASS}
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
      <MemoryCollection key={selectedKey} scope={scope} />
    </section>
  );
}
