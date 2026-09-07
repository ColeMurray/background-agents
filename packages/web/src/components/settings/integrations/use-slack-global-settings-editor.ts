import { useState } from "react";
import type { KeyedMutator } from "swr";
import { toast } from "sonner";
import type {
  SlackGlobalSettings,
  SlackGlobalSettingsResponse,
  SlackGlobalSettingsUpdate,
  SlackRoutingRule,
} from "@open-inspect/shared/types/integrations";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export const SLACK_GLOBAL_SETTINGS_KEY = "/api/integration-settings/slack";

type MutationKind = SlackGlobalSettingsUpdate["section"];

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export function useSlackGlobalSettingsEditor(
  mutateSettings: KeyedMutator<SlackGlobalSettingsResponse>
) {
  const [pendingKind, setPendingKind] = useState<MutationKind | null>(null);

  const runMutation = async (
    kind: MutationKind,
    update: SlackGlobalSettingsUpdate,
    successMessage: string,
    failureMessage: string
  ): Promise<boolean> => {
    setPendingKind(kind);
    try {
      const response = await browserApiFetch(SLACK_GLOBAL_SETTINGS_KEY, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      if (!response.ok) {
        toast.error(await errorMessage(response, failureMessage));
        return false;
      }

      const saved = (await response.json()) as SlackGlobalSettingsResponse;
      await mutateSettings(saved, { revalidate: false });
      toast.success(successMessage);
      return true;
    } catch {
      toast.error(failureMessage);
      return false;
    } finally {
      setPendingKind(null);
    }
  };

  return {
    saving: pendingKind !== null,
    savingDefaults: pendingKind === "defaults",
    savingRoutingRules: pendingKind === "routingRules",
    saveDefaults: (defaults: Omit<SlackGlobalSettings, "routingRules">) =>
      runMutation(
        "defaults",
        { section: "defaults", defaults },
        "Settings saved.",
        "Failed to save settings"
      ),
    resetDefaults: () =>
      runMutation(
        "defaults",
        { section: "defaults", defaults: {} },
        "Settings reset to defaults.",
        "Failed to reset settings"
      ),
    saveRoutingRules: (routingRules: SlackRoutingRule[]) =>
      runMutation(
        "routingRules",
        { section: "routingRules", routingRules },
        "Routing rules saved.",
        "Failed to save routing rules"
      ),
  };
}
