import type { BrowserApiPath } from "@/lib/browser-api-fetch";

export function sessionAccessKey(sessionId: string): BrowserApiPath {
  return `/api/sessions/${encodeURIComponent(sessionId)}/access`;
}
