import { useEffect, useRef, useState } from "react";
import { mutate } from "swr";
import { toast } from "sonner";
import type {
  SlackGlobalConfig,
  SlackGlobalSettings,
  SlackRoutingRule,
} from "@open-inspect/shared/types/integrations";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export const SLACK_GLOBAL_SETTINGS_KEY = "/api/integration-settings/slack";

type MutationKind = "defaults" | "routingRules";

function mergeDefaults(
  current: SlackGlobalConfig | null | undefined,
  patch: Partial<SlackGlobalSettings>
): SlackGlobalConfig {
  const defaults: SlackGlobalSettings = { ...current?.defaults, ...patch };
  for (const key of Object.keys(defaults) as (keyof SlackGlobalSettings)[]) {
    if (defaults[key] === undefined) delete defaults[key];
  }
  return { ...current, defaults };
}

function resetDefaults(current: SlackGlobalConfig | null | undefined): SlackGlobalConfig | null {
  const { defaults, ...rest } = current ?? {};
  const next: SlackGlobalConfig = defaults?.routingRules?.length
    ? { ...rest, defaults: { routingRules: defaults.routingRules } }
    : rest;
  return Object.keys(next).length > 0 ? next : null;
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export function useSlackGlobalSettingsEditor(settings: SlackGlobalConfig | null | undefined) {
  const acceptedSettings = useRef(settings);
  const queue = useRef(Promise.resolve());
  const queuedMutationCount = useRef(0);
  const [pending, setPending] = useState<Record<MutationKind, number>>({
    defaults: 0,
    routingRules: 0,
  });

  useEffect(() => {
    if (settings !== undefined && queuedMutationCount.current === 0) {
      acceptedSettings.current = settings;
    }
  }, [settings]);

  const runMutation = async (
    kind: MutationKind,
    update: (current: SlackGlobalConfig | null | undefined) => SlackGlobalConfig | null,
    successMessage: string,
    failureMessage: string
  ): Promise<boolean> => {
    queuedMutationCount.current += 1;
    setPending((current) => ({ ...current, [kind]: current[kind] + 1 }));

    const operation = queue.current.then(async () => {
      const next = update(acceptedSettings.current);
      try {
        const response = next
          ? await browserApiFetch(SLACK_GLOBAL_SETTINGS_KEY, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ settings: next }),
            })
          : await browserApiFetch(SLACK_GLOBAL_SETTINGS_KEY, { method: "DELETE" });

        if (!response.ok) {
          toast.error(await errorMessage(response, failureMessage));
          return false;
        }

        acceptedSettings.current = next;
        void mutate(SLACK_GLOBAL_SETTINGS_KEY, { settings: next }, { revalidate: false }).catch(
          () => undefined
        );
        toast.success(successMessage);
        return true;
      } catch {
        toast.error(failureMessage);
        return false;
      }
    });

    queue.current = operation.then(() => undefined);
    const succeeded = await operation;

    queuedMutationCount.current -= 1;
    setPending((current) => ({ ...current, [kind]: current[kind] - 1 }));
    if (queuedMutationCount.current === 0) {
      void mutate(SLACK_GLOBAL_SETTINGS_KEY);
    }
    return succeeded;
  };

  return {
    savingDefaults: pending.defaults > 0,
    savingRoutingRules: pending.routingRules > 0,
    saveDefaults: (patch: Partial<SlackGlobalSettings>) =>
      runMutation(
        "defaults",
        (current) => mergeDefaults(current, patch),
        "Settings saved.",
        "Failed to save settings"
      ),
    resetDefaults: () =>
      runMutation(
        "defaults",
        resetDefaults,
        "Settings reset to defaults.",
        "Failed to reset settings"
      ),
    saveRoutingRules: (rules: SlackRoutingRule[]) =>
      runMutation(
        "routingRules",
        (current) => mergeDefaults(current, { routingRules: rules.length > 0 ? rules : undefined }),
        "Routing rules saved.",
        "Failed to save routing rules"
      ),
  };
}
