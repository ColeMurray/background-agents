"use client";

import { toast } from "sonner";
import { MODEL_OPTIONS } from "@open-inspect/shared/models";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

export function ModelsSettings() {
  const {
    enabledModels: storedEnabledModels,
    loading,
    error,
    saving,
    saveEnabledModels,
  } = useEnabledModels();
  const enabledModels = new Set(storedEnabledModels);

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
    try {
      await saveEnabledModels(Array.from(next));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save preferences");
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

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Unable to load model preferences. Please reload to try again.
      </p>
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
