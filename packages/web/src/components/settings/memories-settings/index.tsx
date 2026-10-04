"use client";

import { useId, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  memoryScopeFromSearchParams,
  memoryScopeDisplayKey,
  type MemoryScope,
} from "@open-inspect/shared/types/memories";
import { setMemoryPreferences, useMemoryPreferences } from "@/hooks/use-memories";
import { useRepos } from "@/hooks/use-repos";
import { useEnvironments } from "@/hooks/use-environments";
import { PERSONAL_MEMORY_DISCLOSURE } from "@/lib/memories";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
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
      setSaveError(cause instanceof Error ? cause.message : "Save failed");
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
        <label htmlFor={switchId}>Include my personal memories in new sessions by default</label>
      </div>
      <p className="text-xs text-muted-foreground">
        Applies across web and integration-created sessions. You can override it when starting a web
        session. Existing sessions keep their original selection.
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

/** Combine owner-only memory management with the future-session inclusion default. */
export function MemoriesSettings() {
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
      <MemoryCollection scope={{ type: "personal" }} />
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
      label: `Environment: ${environment.name}`,
    })),
  ];
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">Shared memories</h2>
        <p className="text-sm text-muted-foreground">
          Curate repository and environment knowledge. Agent proposals require approval before other
          sessions load them.
        </p>
      </div>
      <Select
        value={scope ? memoryScopeDisplayKey(scope) : ""}
        onValueChange={(key) =>
          setSelection(
            options.find((option) => memoryScopeDisplayKey(option.scope) === key)?.scope ?? null
          )
        }
      >
        <SelectTrigger aria-label="Memory scope">
          <SelectValue placeholder="Choose a repository or environment" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => {
            const key = memoryScopeDisplayKey(option.scope);
            return (
              <SelectItem key={key} value={key}>
                {option.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {(reposLoading || environmentsLoading) && <p className="text-sm">Loading scopes…</p>}
      {(reposError || environmentsError) && (
        <p role="alert">Some memory scopes could not be loaded.</p>
      )}
      {scope ? (
        <MemoryCollection key={memoryScopeDisplayKey(scope)} scope={scope} />
      ) : (
        <p className="text-sm text-muted-foreground">Select a scope to view its memories.</p>
      )}
    </section>
  );
}
