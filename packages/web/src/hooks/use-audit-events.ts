"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  auditEventListResponseSchema,
  type AuditEventListResponse,
} from "@open-inspect/shared/types/audit-events";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

export const AUDIT_EVENT_PAGE_SIZE = 25;

export function auditEventsKey(cursor?: string): BrowserApiPath {
  const params = new URLSearchParams({ limit: String(AUDIT_EVENT_PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  return `/api/audit-events?${params.toString()}`;
}

async function fetchAuditEvents(path: BrowserApiPath): Promise<AuditEventListResponse> {
  const response = await browserApiFetch(path);
  if (!response.ok) throw new Error(`Audit log request failed (${response.status})`);
  const parsed = auditEventListResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Invalid audit log response");
  return parsed.data;
}

/** Loads one audit page and retains opaque cursors for bidirectional navigation. */
export function useAuditEvents() {
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const result = useSWR(auditEventsKey(cursorHistory.at(-1)), fetchAuditEvents);

  return {
    events: result.data?.events ?? [],
    loading: result.isLoading,
    validating: result.isValidating,
    error: result.error,
    page: cursorHistory.length + 1,
    hasPrevious: cursorHistory.length > 0,
    hasNext: result.data?.hasMore ?? false,
    previous: () => setCursorHistory((current) => current.slice(0, -1)),
    next: () => {
      if (!result.data?.hasMore) return;
      const nextCursor = result.data.nextCursor;
      setCursorHistory((current) => {
        if (current.at(-1) === nextCursor) return current;
        return [...current, nextCursor];
      });
    },
    retry: result.mutate,
  };
}
