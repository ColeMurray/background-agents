"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import type { CodeServerSettings, EnvironmentRepository } from "@open-inspect/shared";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SandboxSettingsEditor } from "./sandbox-settings";

interface EnvironmentCodeServerResponse {
  integrationId: string;
  environmentId: string;
  settings: CodeServerSettings | null;
}

type CodeServerChoice = "inherit" | "enabled" | "disabled";

const CODE_SERVER_CHOICES: Array<{ value: CodeServerChoice; label: string }> = [
  { value: "inherit", label: "Inherit" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

/**
 * Environment-level overrides for the session-scoped integration settings
 * (design §13.5): the top layer above the primary repository's settings.
 * Applies to sessions launched from this environment and to its image builds.
 */
export function EnvironmentIntegrationSettings({
  environmentId,
  repositories,
}: {
  environmentId: string;
  repositories: EnvironmentRepository[];
}) {
  const primary = repositories[0];
  const primaryLabel = primary
    ? `${primary.repoOwner}/${primary.repoName}`
    : "the primary repository";

  return (
    <div className="space-y-8">
      <p className="text-xs text-muted-foreground">
        Overrides for sessions launched from this environment and for its image builds. Anything
        left unset inherits from {primaryLabel}&apos;s settings.
      </p>

      <EnvironmentCodeServerOverride environmentId={environmentId} />

      <div>
        <h3 className="text-sm font-medium text-foreground mb-1">Sandbox</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Inherited values are shown as the current settings; saving only pins the fields you
          change.
        </p>
        <SandboxSettingsEditor
          scope="environment"
          environmentId={environmentId}
          owner={primary?.repoOwner}
          name={primary?.repoName}
        />
      </div>
    </div>
  );
}

/**
 * The code-server enablement override: inherit from the primary repository's
 * resolved setting, or force it on/off for this environment. "Inherit" is
 * modeled as no stored override at all.
 */
function EnvironmentCodeServerOverride({ environmentId }: { environmentId: string }) {
  const apiUrl = `/api/integration-settings/code-server/environments/${environmentId}`;
  const { data, mutate, isLoading } = useSWR<EnvironmentCodeServerResponse>(apiUrl);

  const current: CodeServerChoice =
    data?.settings?.enabled === true
      ? "enabled"
      : data?.settings?.enabled === false
        ? "disabled"
        : "inherit";
  const [choice, setChoice] = useState<CodeServerChoice | null>(null);
  const [saving, setSaving] = useState(false);
  const resolved = choice ?? current;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res =
        resolved === "inherit"
          ? await fetch(apiUrl, { method: "DELETE" })
          : await fetch(apiUrl, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ settings: { enabled: resolved === "enabled" } }),
            });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Failed to save (${res.status})`);
      }
      await mutate();
      setChoice(null);
      toast.success("Code editor setting saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-foreground mb-1">Code Editor</h3>
      <p className="text-xs text-muted-foreground mb-3">
        Whether sessions from this environment get the browser-based editor.
      </p>
      <div className="flex items-center gap-2 max-w-sm">
        <Select
          value={resolved}
          onValueChange={(value) => setChoice(value as CodeServerChoice)}
          disabled={isLoading}
        >
          <SelectTrigger className="w-40" aria-label="Code editor override">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODE_SERVER_CHOICES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={handleSave} disabled={saving || choice === null}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
