"use client";

import { toast } from "sonner";
import { MODEL_OPTIONS, type ValidModel } from "@open-inspect/shared/models";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

export function ModelsSettings() {
  const {
    enabledModels: storedEnabledModels,
    loading,
    error,
    saving,
    updateModels,
  } = useEnabledModels();
  const enabledModels = new Set(storedEnabledModels);

  const toggleModel = (modelId: ValidModel) => {
    const enabled = !enabledModels.has(modelId);
    if (!enabled && enabledModels.size <= 1) return;
    void savePreferences([{ modelId, enabled }]);
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
    void savePreferences(
      category.models.map((model) => ({ modelId: model.id, enabled: next.has(model.id) }))
    );
  };

  const savePreferences = async (changes: Parameters<typeof updateModels>[0]) => {
    try {
      await updateModels(changes);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save preferences");
    }
  };

  if (loading) {
    return <ModelsSettingsSkeleton />;
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

/** Mirrors the loaded list; the model catalog is static, so every group and row is known. */
function ModelsSettingsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading model preferences"
      className="animate-pulse motion-reduce:animate-none"
    >
      <div className="h-5 w-40 bg-muted rounded mt-1 mb-2" />
      <div className="mb-6 py-0.5">
        <div className="h-4 w-11/12 bg-muted rounded" />
      </div>

      <div className="space-y-6">
        {MODEL_OPTIONS.map((group) => (
          <div key={group.category}>
            <div className="flex items-center justify-between mb-3">
              <div className="h-4 w-28 bg-muted rounded" />
              <div className="h-6 w-16 bg-muted rounded" />
            </div>
            <div className="space-y-2">
              {group.models.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center justify-between px-4 py-3 border border-border"
                >
                  <div className="h-4 w-64 max-w-[70%] bg-muted rounded my-1" />
                  <div className="h-5 w-9 shrink-0 bg-muted rounded-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
