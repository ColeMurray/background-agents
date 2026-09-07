"use client";

import useSWR, { useSWRConfig } from "swr";
import { toast } from "sonner";
import { MODEL_OPTIONS } from "@open-inspect/shared/models";
import { MODEL_PREFERENCES_KEY, useEnabledModels } from "@/hooks/use-enabled-models";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { browserApiFetch } from "@/lib/browser-api-fetch";

const PENDING_MODELS_KEY = "model-preferences:pending";

export function ModelsSettings() {
  const { cache, mutate } = useSWRConfig();
  const { enabledModels: storedEnabledModels, loading } = useEnabledModels();
  // Keep the selection and write lock across settings-panel unmounts.
  const { data: pendingModels, mutate: setPendingModels } = useSWR<string[] | null>(
    PENDING_MODELS_KEY,
    null
  );
  const enabledModels = new Set(pendingModels ?? storedEnabledModels);
  const saving = !!pendingModels;

  const toggleModel = (modelId: string) => {
    const next = new Set(enabledModels);
    if (next.has(modelId)) {
      if (next.size <= 1) return;
      next.delete(modelId);
    } else {
      next.add(modelId);
    }
    void savePreferences(next);
  };

  const toggleCategory = (category: (typeof MODEL_OPTIONS)[number], enable: boolean) => {
    const next = new Set(enabledModels);
    for (const model of category.models) {
      if (enable) {
        next.add(model.id);
      } else {
        next.delete(model.id);
      }
    }
    if (next.size === 0) return;
    void savePreferences(next);
  };

  const savePreferences = async (next: Set<string>) => {
    if (cache.get(PENDING_MODELS_KEY)?.data) return;
    await setPendingModels(Array.from(next), { revalidate: false });

    try {
      const res = await browserApiFetch("/api/model-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledModels: Array.from(next) }),
      });

      if (res.ok) {
        await mutate(
          MODEL_PREFERENCES_KEY,
          { enabledModels: Array.from(next) },
          { revalidate: false }
        );
      } else {
        const data = await res.json();
        throw new Error(data.error || "Failed to save preferences");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save preferences");
    } finally {
      await setPendingModels(null, { revalidate: false });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        Loading model preferences...
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Enabled Models</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Choose which models appear in the model selector across the web UI and Slack bot. Changes
        are saved automatically.
      </p>

      <div className="space-y-6">
        {MODEL_OPTIONS.map((group) => {
          const allEnabled = group.models.every((m) => enabledModels.has(m.id));

          return (
            <div key={group.category}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-foreground uppercase tracking-wider">
                  {group.category}
                </h3>
                <Button
                  type="button"
                  variant="subtle"
                  size="xs"
                  disabled={saving}
                  onClick={() => toggleCategory(group, !allEnabled)}
                  className="text-accent hover:text-accent/80"
                >
                  {allEnabled ? "Disable all" : "Enable all"}
                </Button>
              </div>
              <div className="space-y-2">
                {group.models.map((model) => {
                  const isEnabled = enabledModels.has(model.id);
                  return (
                    <label
                      key={model.id}
                      htmlFor={`model-toggle-${model.id}`}
                      className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition cursor-pointer"
                    >
                      <div>
                        <span className="text-sm font-medium text-foreground">{model.name}</span>
                        <span className="text-sm text-muted-foreground ml-2">
                          {model.description}
                        </span>
                      </div>
                      <Switch
                        id={`model-toggle-${model.id}`}
                        checked={isEnabled}
                        disabled={saving}
                        onCheckedChange={() => toggleModel(model.id)}
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <p role="status" className="mt-6 text-sm text-muted-foreground">
        {saving ? "Saving..." : ""}
      </p>
    </div>
  );
}
