"use client";

import { useState } from "react";
import useSWR from "swr";
import {
  auditEventListResponseSchema,
  type AuditEventListResponse,
} from "@open-inspect/shared/types/audit-events";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { useAuthSession } from "@/lib/auth-session";

export const AUDIT_EVENT_PAGE_SIZE = 25;

interface AuditEventsOptions {
  teamId?: string;
  action?: string;
  endpoint?: BrowserApiPath;
  enabled?: boolean;
}

export function auditEventsKey(cursor?: string, options: AuditEventsOptions = {}): BrowserApiPath {
  const params = new URLSearchParams({ limit: String(AUDIT_EVENT_PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  if (options.teamId) params.set("teamId", options.teamId);
  if (options.action) params.set("action", options.action);
  return `${options.endpoint ?? "/api/audit-events"}?${params.toString()}`;
}

class AuditEventsRequestError extends Error {
  constructor(readonly status: number) {
    super(`Audit log request failed (${status})`);
  }
}

async function fetchAuditEvents(path: BrowserApiPath): Promise<AuditEventListResponse> {
  const response = await browserApiFetch(path);
  if (!response.ok) throw new AuditEventsRequestError(response.status);
  const parsed = auditEventListResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Invalid audit log response");
  return parsed.data;
}

/** Loads one audit page and retains opaque cursors for bidirectional navigation. */
export function useAuditEvents(options: AuditEventsOptions = {}) {
  const { data: session } = useAuthSession();
  const userId = session?.user.id;
  const identity = JSON.stringify([userId, auditEventsKey(undefined, options)]);
  const [pagination, setPagination] = useState({ identity, cursors: [] as string[] });
  const cursorHistory = pagination.identity === identity ? pagination.cursors : [];
  // Reset before committing a new viewer or filter so an old cursor never scopes a new request.
  if (pagination.identity !== identity) setPagination({ identity, cursors: [] });
  const result = useSWR<AuditEventListResponse, Error>(
    userId && options.enabled !== false
      ? ([auditEventsKey(cursorHistory.at(-1), options), userId] as const)
      : null,
    ([path]: readonly [BrowserApiPath, string]) => fetchAuditEvents(path),
    { keepPreviousData: false }
  );
  const accessDenied =
    result.error instanceof AuditEventsRequestError &&
    [401, 403, 404].includes(result.error.status);
  const data = userId && options.enabled !== false && !accessDenied ? result.data : undefined;

  return {
    events: data?.events ?? [],
    loading: result.isLoading,
    validating: result.isValidating,
    error: result.error,
    page: cursorHistory.length + 1,
    hasPrevious: cursorHistory.length > 0,
    hasNext: data?.hasMore ?? false,
    previous: () => setPagination({ identity, cursors: cursorHistory.slice(0, -1) }),
    next: () => {
      if (!data?.hasMore) return;
      const nextCursor = data.nextCursor;
      setPagination((current) => {
        if (current.identity !== identity || current.cursors.at(-1) === nextCursor) return current;
        return { identity, cursors: [...current.cursors, nextCursor] };
      });
    },
    retry: result.mutate,
  };
}
