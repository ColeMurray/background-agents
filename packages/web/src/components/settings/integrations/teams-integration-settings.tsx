"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import {
  MODEL_REASONING_CONFIG,
  TEAMS_TYPING_MODES,
  isValidReasoningEffort,
  type TeamsBotSettings,
  type TeamsGlobalConfig,
  type ValidModel,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form-controls";

const SETTINGS_KEY = "/api/integration-settings/teams";

interface SettingsResponse {
  settings: TeamsGlobalConfig | null;
}

export function TeamsIntegrationSettings() {
  const { data, isLoading } = useSWR<SettingsResponse>(SETTINGS_KEY);
  const { enabledModelOptions } = useEnabledModels();

  if (isLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  return (
    <div>
      <h3 className="text-lg font-semibold text-foreground mb-1">Microsoft Teams Bot</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Configure model defaults for Teams-triggered coding sessions. Users can override the model
        via the settings command in Teams.
      </p>

      <SettingsSection
        settings={data?.settings?.defaults}
        enabledModelOptions={enabledModelOptions}
      />
    </div>
  );
}

function SettingsSection({
  settings,
  enabledModelOptions,
}: {
  settings: TeamsBotSettings | null | undefined;
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [model, setModel] = useState(settings?.model ?? "");
  const [effort, setEffort] = useState(settings?.reasoningEffort ?? "");
  const [typingMode, setTypingMode] = useState<string>(settings?.typingMode ?? "response");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setModel(settings.model ?? "");
        setEffort(settings.reasoningEffort ?? "");
        setTypingMode(settings.typingMode ?? "response");
      }
      setInitialized(true);
    }
  }, [settings, initialized]);

  const isConfigured = settings !== null && settings !== undefined;
  const reasoningConfig = model ? MODEL_REASONING_CONFIG[model as ValidModel] : undefined;

  const handleReset = async () => {
    if (!window.confirm("Reset Teams bot settings to defaults?")) return;

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(SETTINGS_KEY, { method: "DELETE" });

      if (res.ok) {
        mutate(SETTINGS_KEY);
        setModel("");
        setEffort("");
        setTypingMode("response");
        setDirty(false);
        setSuccess("Settings reset to defaults.");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to reset settings");
      }
    } catch {
      setError("Failed to reset settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSuccess("");

    const defaults: TeamsBotSettings = {};
    if (model) defaults.model = model;
    if (effort) defaults.reasoningEffort = effort;
    if (typingMode !== "response")
      defaults.typingMode = typingMode as TeamsBotSettings["typingMode"];

    const body: TeamsGlobalConfig = { defaults };

    try {
      const res = await fetch(SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });

      if (res.ok) {
        mutate(SETTINGS_KEY);
        setSuccess("Settings saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to save settings");
      }
    } catch {
      setError("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Defaults" description="Default model and reasoning effort for Teams sessions.">
      {error && <Message tone="error" text={error} />}
      {success && <Message tone="success" text={success} />}

      <div className="grid sm:grid-cols-3 gap-3 mb-4">
        <label className="text-sm">
          <span className="block text-foreground font-medium mb-1">Default model</span>
          <Select
            value={model}
            onChange={(e) => {
              const nextModel = e.target.value;
              setModel(nextModel);
              if (effort && nextModel && !isValidReasoningEffort(nextModel, effort)) {
                setEffort("");
              }
              setDirty(true);
              setError("");
              setSuccess("");
            }}
            className="w-full"
          >
            <option value="">Use system default</option>
            {enabledModelOptions.map((group) => (
              <optgroup key={group.category} label={group.category}>
                {group.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </label>

        <label className="text-sm">
          <span className="block text-foreground font-medium mb-1">Default reasoning effort</span>
          <Select
            value={effort}
            onChange={(e) => {
              setEffort(e.target.value);
              setDirty(true);
              setError("");
              setSuccess("");
            }}
            disabled={!reasoningConfig}
            className="w-full"
          >
            <option value="">Use model default</option>
            {(reasoningConfig?.efforts ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </label>

        <label className="text-sm">
          <span className="block text-foreground font-medium mb-1">Typing indicator</span>
          <Select
            value={typingMode}
            onChange={(e) => {
              setTypingMode(e.target.value);
              setDirty(true);
              setError("");
              setSuccess("");
            }}
            className="w-full"
          >
            {TEAMS_TYPING_MODES.map((mode: { value: string; label: string }) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>

        {isConfigured && (
          <Button variant="destructive" onClick={handleReset} disabled={saving}>
            Reset to defaults
          </Button>
        )}
      </div>
    </Section>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-border-muted rounded-md p-5 mb-5">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-foreground mb-1">
        {title}
      </h4>
      <p className="text-sm text-muted-foreground mb-4">{description}</p>
      {children}
    </section>
  );
}

function Message({ tone, text }: { tone: "error" | "success"; text: string }) {
  const classes =
    tone === "error"
      ? "mb-4 bg-red-50 text-red-700 px-4 py-3 border border-red-200 text-sm rounded-sm"
      : "mb-4 bg-green-50 text-green-700 px-4 py-3 border border-green-200 text-sm rounded-sm";

  return (
    <div className={classes} aria-live="polite">
      {text}
    </div>
  );
}
