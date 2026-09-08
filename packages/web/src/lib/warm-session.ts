import { browserApiFetch } from "@/lib/browser-api-fetch";

export async function retireWarmDraftSession(sessionId: string): Promise<void> {
  try {
    const response = await browserApiFetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/archive`,
      {
        method: "POST",
      }
    );
    if (!response.ok) throw new Error(`Warm session archive failed: ${response.status}`);
  } catch (error) {
    console.error("Failed to retire superseded warm session:", error);
  }
}
