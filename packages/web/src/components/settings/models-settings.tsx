"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { MODEL_OPTIONS, DEFAULT_ENABLED_MODELS, isValidModel } from "@open-inspect/shared";
import { MODEL_PREFERENCES_KEY } from "@/hooks/use-enabled-models";
import { formatPremiumMultiplierLabel } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

function sanitizeEnabledModels(modelIds: Iterable<string>): Set<string> {
  return new Set(Array.from(modelIds).filter((modelId) => isValidModel(modelId)));
}

export function ModelsSettings() {
  const { data, isLoading: loading } = useSWR<{ enabledModels: string[] }>(MODEL_PREFERENCES_KEY);
  const [enabledModels, setEnabledModels] = useState<Set<string>>(
    sanitizeEnabledModels(DEFAULT_ENABLED_MODELS)
  );
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Sync SWR data into local state once on initial load
  if (data?.enabledModels && !initialized) {
    setEnabledModels(sanitizeEnabledModels(data.enabledModels));
    setInitialized(true);
  }

  const toggleModel = (modelId: string) => {
    setEnabledModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        if (next.size <= 1) return prev;
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
    setDirty(true);
  };

  const toggleCategory = (category: (typeof MODEL_OPTIONS)[number], enable: boolean) => {
    setEnabledModels((prev) => {
      const next = new Set(prev);
      for (const model of category.models) {
        if (enable) {
          next.add(model.id);
        } else {
          next.delete(model.id);
        }
      }
      if (next.size === 0) return prev;
      return next;
    });
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);

    try {
      const sanitizedEnabledModels = Array.from(sanitizeEnabledModels(enabledModels));
      const res = await fetch("/api/model-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledModels: sanitizedEnabledModels }),
      });

      if (res.ok) {
        mutate(MODEL_PREFERENCES_KEY);
        toast.success("Model preferences saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save preferences");
      }
    } catch {
      toast.error("Failed to save preferences");
    } finally {
      setSaving(false);
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
        Choose which models appear in the model selector across the web UI and Slack bot.
      </p>
      <p className="text-sm text-muted-foreground mb-6">
        GitHub Copilot models show their premium request multiplier here. Free means the
        multiplier is <code>0</code>.
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
                <button
                  type="button"
                  onClick={() => toggleCategory(group, !allEnabled)}
                  className="text-xs text-accent hover:text-accent/80 transition"
                >
                  {allEnabled ? "Disable all" : "Enable all"}
                </button>
              </div>
              <div className="space-y-2">
                {group.models.map((model) => {
                  const isEnabled = enabledModels.has(model.id);
                  const premiumMultiplierLabel = formatPremiumMultiplierLabel(model.premiumMultiplier);
                  return (
                    <label
                      key={model.id}
                      htmlFor={`model-toggle-${model.id}`}
                      className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition cursor-pointer"
                    >
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{model.name}</span>
                          {premiumMultiplierLabel && (
                            <span className="rounded-full border border-border-muted px-2 py-0.5 text-xs text-muted-foreground">
                              {premiumMultiplierLabel}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground">{model.description}</div>
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

      <div className="mt-6">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
