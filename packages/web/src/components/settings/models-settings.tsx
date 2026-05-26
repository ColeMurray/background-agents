"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  MODEL_OPTIONS,
  DEFAULT_ENABLED_MODELS,
  DEFAULT_MODEL,
  DEFAULT_PLAN_MODEL,
} from "@open-inspect/shared";
import { MODEL_PREFERENCES_KEY } from "@/hooks/use-enabled-models";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { ChevronDownIcon } from "@/components/ui/icons";
import { formatModelNameLower } from "@/lib/format";

interface ModelPreferencesResponse {
  enabledModels: string[];
  defaultModel?: string;
  defaultPlanModel?: string;
}

export function ModelsSettings() {
  const { data, isLoading: loading } = useSWR<ModelPreferencesResponse>(MODEL_PREFERENCES_KEY);
  const [enabledModels, setEnabledModels] = useState<Set<string>>(new Set(DEFAULT_ENABLED_MODELS));
  const [defaultModel, setDefaultModel] = useState<string>(DEFAULT_MODEL);
  const [defaultPlanModel, setDefaultPlanModel] = useState<string>(DEFAULT_PLAN_MODEL);
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Sync SWR data into local state once on initial load. Effect (not render-
  // phase setState) so React doesn't warn about an in-render update.
  useEffect(() => {
    if (!data || initialized) return;
    setEnabledModels(new Set(data.enabledModels));
    if (data.defaultModel) setDefaultModel(data.defaultModel);
    if (data.defaultPlanModel) setDefaultPlanModel(data.defaultPlanModel);
    setInitialized(true);
  }, [data, initialized]);

  const toggleModel = (modelId: string) => {
    setToggleError(null);
    let changed = false;
    setEnabledModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        if (next.size <= 1) return prev;
        if (modelId === defaultModel || modelId === defaultPlanModel) {
          setToggleError(
            `"${formatModelNameLower(modelId)}" is the current default — pick a different default before disabling.`
          );
          return prev;
        }
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      changed = true;
      return next;
    });
    if (changed) setDirty(true);
  };

  const toggleCategory = (category: (typeof MODEL_OPTIONS)[number], enable: boolean) => {
    setToggleError(null);
    let changed = false;
    setEnabledModels((prev) => {
      const next = new Set(prev);
      let blockedDefault: string | null = null;
      for (const model of category.models) {
        if (enable) {
          if (!next.has(model.id)) {
            next.add(model.id);
            changed = true;
          }
        } else {
          if (model.id === defaultModel || model.id === defaultPlanModel) {
            blockedDefault = model.id;
            continue;
          }
          if (next.has(model.id)) {
            next.delete(model.id);
            changed = true;
          }
        }
      }
      if (next.size === 0) return prev;
      if (blockedDefault) {
        setToggleError(
          `"${formatModelNameLower(blockedDefault)}" is the current default — pick a different default before disabling.`
        );
      }
      return next;
    });
    if (changed) setDirty(true);
  };

  const handleDefaultChange = (which: "model" | "plan", value: string) => {
    if (which === "model") setDefaultModel(value);
    else setDefaultPlanModel(value);
    setDirty(true);
    setToggleError(null);
  };

  // Combobox groups filtered to currently-enabled models (the user can only
  // pick a default from what's actually enabled).
  const enabledGroups: ComboboxGroup[] = useMemo(() => {
    return MODEL_OPTIONS.map((group) => ({
      category: group.category,
      options: group.models
        .filter((m) => enabledModels.has(m.id))
        .map((m) => ({ value: m.id, label: m.name, description: m.description })),
    })).filter((g) => g.options.length > 0);
  }, [enabledModels]);

  const handleSave = async () => {
    setSaving(true);

    try {
      const res = await fetch("/api/model-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabledModels: Array.from(enabledModels),
          defaultModel,
          defaultPlanModel,
        }),
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
      <h2 className="text-xl font-semibold text-foreground mb-1">Default Models</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Used as the initial selection across the web UI and as the fallback for the Linear, GitHub,
        and Slack bots.
      </p>

      <div className="space-y-3 mb-8">
        <DefaultModelPicker
          label="Default model"
          value={defaultModel}
          onChange={(v) => handleDefaultChange("model", v)}
          groups={enabledGroups}
        />
        <DefaultModelPicker
          label="Default plan model"
          value={defaultPlanModel}
          onChange={(v) => handleDefaultChange("plan", v)}
          groups={enabledGroups}
        />
      </div>

      <h2 className="text-xl font-semibold text-foreground mb-1">Enabled Models</h2>
      <p className="text-sm text-muted-foreground mb-2">
        Choose which models appear in the model selector across the web UI and Slack bot.
      </p>
      {toggleError && (
        <p className="text-sm text-destructive mb-4" role="alert">
          {toggleError}
        </p>
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
                  const isDefault = model.id === defaultModel || model.id === defaultPlanModel;
                  return (
                    <label
                      key={model.id}
                      htmlFor={`model-toggle-${model.id}`}
                      className="flex items-center justify-between px-4 py-3 border border-border hover:bg-muted/50 transition cursor-pointer"
                    >
                      <div>
                        <span className="text-sm font-medium text-foreground">{model.name}</span>
                        {isDefault && (
                          <span className="ml-2 text-xs uppercase tracking-wider text-accent">
                            Default
                          </span>
                        )}
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

      <div className="mt-6">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

interface DefaultModelPickerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  groups: ComboboxGroup[];
}

function DefaultModelPicker({ label, value, onChange, groups }: DefaultModelPickerProps) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 border border-border">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <Combobox
        value={value}
        onChange={onChange}
        items={groups}
        dropdownWidth="w-72"
        triggerClassName="flex items-center gap-1 text-sm text-foreground hover:text-foreground transition"
      >
        <span>{formatModelNameLower(value)}</span>
        <ChevronDownIcon className="w-3.5 h-3.5 text-muted-foreground" />
      </Combobox>
    </div>
  );
}
