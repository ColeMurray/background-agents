import { toast } from "sonner";
import { browserApiFetch } from "@/lib/browser-api-fetch";

/**
 * Archives a session via the API.
 *
 * Returns `true` when the request succeeds. Callers are responsible for
 * updating any client-side caches or navigation state.
 */
export async function archiveSession(sessionId: string): Promise<boolean> {
  try {
    const response = await browserApiFetch(`/api/sessions/${sessionId}/archive`, {
      method: "POST",
    });
    if (!response.ok) {
      toast.error("Failed to archive session");
      return false;
    }

    return true;
  } catch {
    toast.error("Failed to archive session");
    return false;
  }
}
