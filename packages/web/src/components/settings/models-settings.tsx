"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { MODEL_OPTIONS, DEFAULT_ENABLED_MODELS } from "@open-inspect/shared";
import { MODEL_PREFERENCES_KEY } from "@/hooks/use-enabled-models";

export function ModelsSettings() {
  const { data, isLoading: loading } = useSWR<{ enabledModels: string[] }>(MODEL_PREFERENCES_KEY);
  const [enabledModels, setEnabledModels] = useState<Set<string>>(new Set(DEFAULT_ENABLED_MODELS));
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dirty, setDirty] = useState(false);

  // Sync SWR data into local state once on initial load
  if (data?.enabledModels && !initialized) {
    setEnabledModels(new Set(data.enabledModels));
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
    setError("");
    setSuccess("");
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
    setError("");
    setSuccess("");
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch("/api/model-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledModels: Array.from(enabledModels) }),
      });

      if (res.ok) {
        mutate(MODEL_PREFERENCES_KEY);
        setSuccess("Model preferences saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to save preferences");
      }
    } catch {
      setError("Failed to save preferences");
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

      {error && (
        <div className="mb-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 border border-red-200 dark:border-red-800 text-sm">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 px-4 py-3 border border-green-200 dark:border-green-800 text-sm">
          {success}
        </div>
      )}

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
                  return (
                    <label
                      key={model.id}
                      className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition cursor-pointer"
                    >
                      <div>
                        <span className="text-sm font-medium text-foreground">{model.name}</span>
                        <span className="text-sm text-muted-foreground ml-2">
                          {model.description}
                        </span>
                      </div>
                      <div className="relative">
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={() => toggleModel(model.id)}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-muted rounded-full peer-checked:bg-accent transition-colors" />
                        <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className="px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
