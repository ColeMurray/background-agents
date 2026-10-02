import { useState } from "react";
import { useSWRConfig } from "swr";
import { invalidateAutomationCache } from "@/lib/automation-cache";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

type AutomationAction = "pause" | "resume" | "trigger" | "delete";

export function useAutomationActions() {
  const swr = useSWRConfig();
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(id: string, action: AutomationAction): Promise<boolean> {
    setActionError(null);
    const path: BrowserApiPath =
      action === "delete" ? `/api/automations/${id}` : `/api/automations/${id}/${action}`;
    try {
      const response = await browserApiFetch(path, {
        method: action === "delete" ? "DELETE" : "POST",
      });
      if (!response.ok) throw new Error(`Failed to ${action} automation`);
      await invalidateAutomationCache(swr, id, { deleted: action === "delete" });
      return true;
    } catch {
      setActionError(`Failed to ${action} automation`);
      return false;
    }
  }

  return { act, actionError };
}
