import type { Cache, ScopedMutator } from "swr";
import { unstable_serialize } from "swr/infinite";
import { browserApiFetch, type BrowserApiPath } from "./browser-api-fetch";
import { isMeTeamsCacheKey } from "./me-teams-cache";
import { isSessionListKey } from "./session-list";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import type { SessionSnapshotState } from "@open-inspect/shared/types/server-messages";

export interface SessionScopeControls {
  ownerTeamId: string | null;
  ownerUserId: string | null;
  visibility: SessionVisibility;
  collaborators: string[];
  slackThread?: SessionSnapshotState["slackThread"];
  onUpdated: () => Promise<void>;
}

const INFINITE_CACHE_PREFIX = unstable_serialize(() => null);
const scopeChangeListeners = new Set<() => void>();

export function subscribeSessionScopeChanges(listener: () => void): () => void {
  scopeChangeListeners.add(listener);
  return () => scopeChangeListeners.delete(listener);
}

/** Includes paginated/filtered discovery buckets and aggregates, but not per-session data. */
export function isSessionScopeCacheKey(key: unknown): boolean {
  const rawPath = Array.isArray(key) ? key[0] : key;
  if (typeof rawPath !== "string") return false;
  const path = rawPath.startsWith(INFINITE_CACHE_PREFIX)
    ? rawPath.slice(INFINITE_CACHE_PREFIX.length)
    : rawPath;
  return (
    ["/api/sessions/inbox", "/api/teams", "/api/activity", "/api/audit-events"].some(
      (prefix) => path === prefix || path.startsWith(`${prefix}?`) || path.startsWith(`${prefix}/`)
    ) || isSessionListKey(path)
  );
}

export class SessionScopeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "SessionScopeError";
  }

  get canRetryWithoutChildren(): boolean {
    return (
      this.status === 403 ||
      this.status === 404 ||
      (this.status === 409 && this.code === "descendant_inaccessible")
    );
  }
}

/** onUpdated must explicitly refetch the session snapshot; scope writes do not bump updatedAt. */
export async function updateSessionScope(
  path: BrowserApiPath,
  input: { method: "PUT" | "DELETE"; body?: object },
  onUpdated: () => Promise<void>,
  { mutate, cache }: { mutate: ScopedMutator; cache: Cache }
): Promise<void> {
  const response = await browserApiFetch(path, {
    method: input.method,
    ...(input.body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.body),
        }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    const code = typeof failure?.code === "string" ? failure.code : undefined;
    const reason = typeof failure?.reason_code === "string" ? failure.reason_code : undefined;
    const repository = typeof failure?.repository === "string" ? failure.repository : undefined;
    const message =
      typeof failure?.error === "string"
        ? failure.error
        : `Session update failed (${response.status})`;
    const details = [code, reason, repository].filter(Boolean);
    throw new SessionScopeError(
      response.status,
      code,
      `${message}${details.length ? ` (${details.join(", ")})` : ""}`
    );
  }
  for (const listener of scopeChangeListeners) listener();
  const infiniteKeys = [...cache.keys()].filter(
    (key) =>
      key.startsWith(INFINITE_CACHE_PREFIX) &&
      isSessionScopeCacheKey(key.slice(INFINITE_CACHE_PREFIX.length))
  );
  // Invalidate inactive pages too: a predicate revalidation only fetches mounted hooks.
  // SWR skips aggregates in predicate mutations, so clear those explicitly as well.
  await Promise.all([
    mutate(isSessionScopeCacheKey, undefined, { revalidate: false }),
    ...infiniteKeys.map((key) => mutate(key, undefined, { revalidate: false })),
  ]);
  await Promise.all([
    Promise.resolve().then(onUpdated),
    // Membership data drives access controls and must stay available during revalidation.
    mutate(isMeTeamsCacheKey),
    mutate(isSessionScopeCacheKey),
    ...infiniteKeys.map((key) => mutate(key)),
  ]);
}
