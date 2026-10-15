/** @param {{provider: string, prefix: string}} policy */
export function managedNamePattern(policy) {
  const prefix = policy.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${prefix}${policy.provider === "daytona" ? "-m[1-9][0-9]*" : ""}-[a-f0-9]{16}$`
  );
}

const DEFAULT_KEEP_LATEST = 5;
const DEFAULT_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function validatePolicy(input) {
  if (!input || !["vercel", "daytona", "opencomputer"].includes(input.provider)) {
    throw new Error("policy.provider must be vercel, daytona, or opencomputer");
  }
  const prefix =
    input.prefix ??
    { vercel: "openinspect-base", opencomputer: "openinspect-runtime" }[input.provider];
  if (typeof prefix !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(prefix)) {
    throw new Error(
      "policy.prefix must be an explicit base snapshot prefix (required for Daytona)"
    );
  }
  if (
    !Array.isArray(input.protectedReferences) ||
    input.protectedReferences.length === 0 ||
    input.protectedReferences.some((ref) => typeof ref !== "string" || !ref.trim())
  ) {
    throw new Error(
      "policy.protectedReferences must list deployed and rollback snapshot names/IDs"
    );
  }
  const keepLatest = input.keepLatest ?? DEFAULT_KEEP_LATEST;
  const minAgeMs = input.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  if (!Number.isSafeInteger(keepLatest) || keepLatest < 1) {
    throw new Error("policy.keepLatest must be a positive integer");
  }
  if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0) {
    throw new Error("policy.minAgeMs must be a non-negative integer");
  }
  return {
    provider: input.provider,
    prefix,
    protectedReferences: input.protectedReferences,
    keepLatest,
    minAgeMs,
  };
}

export function planCleanup(inventory, input, nowMs = Date.now()) {
  const policy = validatePolicy(input);
  const pattern = managedNamePattern(policy);
  const managed = inventory.filter((snapshot) => pattern.test(snapshot.name));
  const seen = new Set();
  for (const snapshot of managed) {
    if (!snapshot.id || seen.has(snapshot.id)) throw new Error("Invalid or duplicate snapshot ID");
    seen.add(snapshot.id);
  }
  const protectedReferences = new Set(policy.protectedReferences);
  const managedNames = new Set(managed.map((snapshot) => snapshot.name));
  for (const reference of protectedReferences) {
    if (pattern.test(reference) && !managedNames.has(reference) && !seen.has(reference)) {
      throw new Error(`Protected managed reference is absent from inventory: ${reference}`);
    }
  }
  const isProtected = (snapshot) =>
    protectedReferences.has(snapshot.id) || protectedReferences.has(snapshot.name);
  if (managed.length && !managed.some(isProtected)) {
    throw new Error(
      "No protected reference matches the managed inventory; check account and policy"
    );
  }
  const newest = new Set(
    managed
      .filter((snapshot) => snapshot.ready && Number.isFinite(snapshot.createdAtMs))
      .sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id))
      .slice(0, policy.keepLatest)
      .map((snapshot) => snapshot.id)
  );
  const result = { provider: policy.provider, keep: [], delete: [] };
  for (const snapshot of managed) {
    let reason;
    if (isProtected(snapshot)) reason = "protected";
    else if (newest.has(snapshot.id)) reason = "newest";
    else if (!snapshot.terminal) reason = "not-terminal";
    else if (
      !Number.isFinite(snapshot.createdAtMs) ||
      (snapshot.lastUsedAtMs != null && !Number.isFinite(snapshot.lastUsedAtMs))
    )
      reason = "unknown-age";
    else if (nowMs - Math.max(snapshot.createdAtMs, snapshot.lastUsedAtMs ?? 0) < policy.minAgeMs)
      reason = "recent";
    const entry = { id: snapshot.id, name: snapshot.name };
    if (reason) result.keep.push({ ...entry, reason });
    else result.delete.push(entry);
  }
  return result;
}

export async function cleanup(client, policy, { apply = false, nowMs = Date.now() } = {}) {
  // Finish listing and validating every page before the first mutation.
  const plan = planCleanup(await client.list(), policy, nowMs);
  const deleted = [];
  if (apply) {
    for (const snapshot of plan.delete) {
      await client.delete(snapshot);
      deleted.push(snapshot);
    }
  }
  return { ...plan, apply, deleted };
}
