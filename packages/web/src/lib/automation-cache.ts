import type { Cache, ScopedMutator } from "swr";
import { unstable_serialize } from "swr/infinite";

const INFINITE_CACHE_PREFIX = unstable_serialize(() => null);

export async function invalidateAutomationCache(
  { mutate, cache }: { mutate: ScopedMutator; cache: Cache },
  automationId?: string
): Promise<void> {
  const resourcePath = automationId ? `/api/automations/${automationId}` : undefined;
  const collectionKeys: string[] = [];
  const resourceKeys: string[] = [];
  for (const key of cache.keys()) {
    const path = key.startsWith(INFINITE_CACHE_PREFIX)
      ? key.slice(INFINITE_CACHE_PREFIX.length)
      : key;
    if (path === "/api/automations" || path.startsWith("/api/automations?")) {
      collectionKeys.push(key);
    } else if (
      resourcePath !== undefined &&
      (path === resourcePath ||
        path.startsWith(`${resourcePath}?`) ||
        path.startsWith(`${resourcePath}/`))
    ) {
      resourceKeys.push(key);
    }
  }
  // Predicate revalidation skips inactive pages and infinite aggregates. Clear
  // collection pages first, but retain loaded resources if their refresh fails.
  await Promise.all(collectionKeys.map((key) => mutate(key, undefined, { revalidate: false })));
  await Promise.all([...collectionKeys, ...resourceKeys].map((key) => mutate(key)));
}
