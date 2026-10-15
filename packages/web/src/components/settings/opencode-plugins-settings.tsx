"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  opencodePluginInputSchema,
  type OpencodePlugin,
  type OpencodePluginInput,
} from "@open-inspect/shared/types/opencode-plugins";
import {
  useOpencodePlugins,
  saveOpencodePlugin,
  deleteOpencodePlugin,
} from "@/hooks/use-opencode-plugins";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useRepos } from "@/hooks/use-repos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioCard } from "@/components/ui/form-controls";

type Draft = OpencodePluginInput &
  ({ kind: "new" } | { kind: "existing"; id: string; revision: number });

export function OpencodePluginsSettings() {
  const { plugins, loading, error, mutate } = useOpencodePlugins();
  const { hasPermission } = useCurrentUserAuthorization();
  const canManage = hasPermission("opencode_plugins.manage");
  const canReadRepositories = hasPermission("repositories.read");
  const { repos } = useRepos(canManage && canReadRepositories);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [repositoryScope, setRepositoryScope] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const selectedRepositories = draft?.repoScopes ?? [];
  const repositoryOptions = [
    ...new Set([...repos.map((repo) => repo.fullName.toLowerCase()), ...selectedRepositories]),
  ].sort();

  async function save() {
    if (!draft || saving) return;
    const parsed = opencodePluginInputSchema.safeParse({
      spec: draft.spec,
      enabled: draft.enabled,
      repoScopes: draft.repoScopes,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Invalid plugin");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (draft.kind === "existing") {
        await saveOpencodePlugin({ ...parsed.data, revision: draft.revision }, draft.id);
      } else {
        await saveOpencodePlugin(parsed.data);
      }
      await mutate();
      setDraft(null);
      toast.success("Plugin saved");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save plugin");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(plugin: OpencodePlugin) {
    setSaving(true);
    try {
      await saveOpencodePlugin({ enabled: !plugin.enabled }, plugin.id);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update plugin");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setSaving(true);
    try {
      await deleteOpencodePlugin(id);
      await mutate();
    } catch {
      toast.error("Failed to delete plugin");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold text-foreground">OpenCode plugins</h2>
        {canManage && (
          <Button
            disabled={saving || draft !== null}
            onClick={() => {
              setDraft({ kind: "new", spec: "", enabled: true, repoScopes: null });
              setFormError(null);
            }}
          >
            Add plugin
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Load pinned npm plugins in new and restored OpenCode sessions. Claude and Codex sessions
        ignore these settings.
      </p>
      <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        Only add trusted plugins. They run with the session’s credentials and network access.
        Configure credentials using global, repository, or environment secrets.
      </p>
      {draft && (
        <form
          className="space-y-4 rounded-lg border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="opencode-plugin-spec">Package and exact version</Label>
            <Input
              id="opencode-plugin-spec"
              value={draft.spec}
              disabled={saving}
              placeholder="@company/audit@1.2.3"
              onChange={(event) => setDraft({ ...draft, spec: event.target.value })}
            />
          </div>
          <fieldset disabled={saving} className="space-y-3">
            <legend className="mb-2 text-sm font-medium">Scope</legend>
            <RadioCard
              name="plugin-scope"
              checked={draft.repoScopes === null}
              onChange={() => setDraft({ ...draft, repoScopes: null })}
              label="Global"
              description="Every OpenCode session"
            />
            <RadioCard
              name="plugin-scope"
              checked={draft.repoScopes !== null}
              onChange={() => setDraft({ ...draft, repoScopes: [] })}
              label="Selected repositories"
              description="Any matching repository in a session"
            />
            {draft.repoScopes !== null && (
              <div className="max-h-48 space-y-2 overflow-y-auto">
                {repositoryOptions.map((fullName) => (
                  <label key={fullName} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selectedRepositories.includes(fullName)}
                      onCheckedChange={(checked) =>
                        setDraft({
                          ...draft,
                          repoScopes: checked
                            ? [...selectedRepositories, fullName]
                            : selectedRepositories.filter((name) => name !== fullName),
                        })
                      }
                    />
                    {fullName}
                  </label>
                ))}
                <div className="space-y-2">
                  <Label htmlFor="plugin-repository-scope">Repository name</Label>
                  <div className="flex gap-2">
                    <Input
                      id="plugin-repository-scope"
                      placeholder="owner/repository"
                      value={repositoryScope}
                      onChange={(event) => setRepositoryScope(event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        const scope = repositoryScope.trim().toLowerCase();
                        const input = opencodePluginInputSchema.shape.repoScopes.safeParse([scope]);
                        if (!input.success) {
                          setFormError("Enter a repository as owner/repository");
                          return;
                        }
                        setDraft({
                          ...draft,
                          repoScopes: [...new Set([...selectedRepositories, scope])],
                        });
                        setRepositoryScope("");
                        setFormError(null);
                      }}
                    >
                      Add repository
                    </Button>
                  </div>
                </div>
                {canReadRepositories && repos.length === 0 && draft.repoScopes.length === 0 && (
                  <p className="text-sm text-muted-foreground">No repositories available.</p>
                )}
              </div>
            )}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={draft.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            />
            Enabled
          </label>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={saving}>
              Save plugin
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load plugins.
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading plugins...</p>
      ) : plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground">No OpenCode plugins configured.</p>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {plugins.map((plugin) => (
            <div key={plugin.id} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="break-all font-mono text-sm">{plugin.spec}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {plugin.repoScopes?.join(", ") ?? "Global"}
                  {!plugin.enabled && " · Disabled"}
                </p>
              </div>
              {canManage && (
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    aria-label={`Enable ${plugin.spec}`}
                    checked={plugin.enabled}
                    disabled={saving || draft !== null}
                    onCheckedChange={() => void toggle(plugin)}
                  />
                  <Button
                    variant="outline"
                    disabled={saving || draft !== null}
                    onClick={() => {
                      setDraft({ ...plugin, kind: "existing" });
                      setFormError(null);
                    }}
                  >
                    Edit<span className="sr-only"> {plugin.spec}</span>
                  </Button>
                  <Button
                    variant="outline"
                    disabled={saving || draft !== null}
                    onClick={() => void remove(plugin.id)}
                  >
                    Delete<span className="sr-only"> {plugin.spec}</span>
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
