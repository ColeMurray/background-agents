import { useRef, useState } from "react";
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
  const pendingMutationCount = useRef(0);
  const [pending, setPending] = useState<Record<MutationKind, number>>({
    defaults: 0,
    routingRules: 0,
  });

  const runMutation = async (
    kind: MutationKind,
    update: SlackGlobalSettingsUpdate,
    successMessage: string,
    failureMessage: string
  ): Promise<boolean> => {
    pendingMutationCount.current += 1;
    setPending((current) => ({ ...current, [kind]: current[kind] + 1 }));
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
      pendingMutationCount.current -= 1;
      if (pendingMutationCount.current === 0) {
        await mutateSettings().catch(() => undefined);
      }
      setPending((current) => ({ ...current, [kind]: current[kind] - 1 }));
    }
  };

  return {
    saving: pending.defaults + pending.routingRules > 0,
    savingDefaults: pending.defaults > 0,
    savingRoutingRules: pending.routingRules > 0,
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
