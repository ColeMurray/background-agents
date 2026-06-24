/**
 * Build authenticated headers for internal control-plane requests (HMAC auth).
 * Shared by every slack-bot → control-plane POST.
 */

import { buildInternalAuthHeaders } from "@open-inspect/shared";
import type { Env } from "./types";

export async function getAuthHeaders(env: Env, traceId?: string): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
  };
}
