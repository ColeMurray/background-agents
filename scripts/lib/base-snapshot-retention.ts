export interface BaseSnapshotPolicyInput {
  provider: "vercel" | "daytona";
  prefix?: string;
  protectedReferences: string[];
  keepLatest?: number;
  minAgeMs?: number;
}

export type BaseSnapshotPolicy = Required<BaseSnapshotPolicyInput>;
export type BaseSnapshotScope = Pick<BaseSnapshotPolicy, "provider" | "prefix">;

export interface BaseSnapshot {
  id: string;
  name: string;
  createdAtMs: number;
  lastUsedAtMs?: number;
  ready: boolean;
  terminal: boolean;
}

export type BaseSnapshotReference = Pick<BaseSnapshot, "id" | "name">;

export interface BaseSnapshotClient {
  list(): Promise<BaseSnapshot[]>;
  delete(snapshot: BaseSnapshotReference): Promise<void>;
}

type KeepReason = "protected" | "newest" | "not-terminal" | "unknown-age" | "recent";

interface CleanupPlan {
  provider: BaseSnapshotPolicy["provider"];
  keep: (BaseSnapshotReference & { reason: KeepReason })[];
  delete: BaseSnapshotReference[];
}

export function managedNamePattern(policy: BaseSnapshotScope): RegExp {
  const prefix = policy.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${prefix}${policy.provider === "daytona" ? "-m[1-9][0-9]*" : ""}-[a-f0-9]{16}$`
  );
}

const DEFAULT_KEEP_LATEST = 5;
const DEFAULT_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function validatePolicy(input: unknown): BaseSnapshotPolicy {
  if (
    typeof input !== "object" ||
    input === null ||
    !("provider" in input) ||
    (input.provider !== "vercel" && input.provider !== "daytona")
  ) {
    throw new Error("policy.provider must be vercel or daytona");
  }
  const prefix =
    ("prefix" in input ? input.prefix : undefined) ??
    (input.provider === "vercel" ? "openinspect-base" : undefined);
  if (typeof prefix !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(prefix)) {
    throw new Error(
      "policy.prefix must be an explicit base snapshot prefix (required for Daytona)"
    );
  }
  const protectedReferences =
    "protectedReferences" in input ? input.protectedReferences : undefined;
  if (
    !Array.isArray(protectedReferences) ||
    protectedReferences.length === 0 ||
    !protectedReferences.every(
      (ref: unknown): ref is string =>
        typeof ref === "string" && ref.length > 0 && ref === ref.trim()
    )
  ) {
    throw new Error(
      "policy.protectedReferences must list deployed and rollback snapshot names/IDs"
    );
  }
  const keepLatest = ("keepLatest" in input ? input.keepLatest : undefined) ?? DEFAULT_KEEP_LATEST;
  const minAgeMs = ("minAgeMs" in input ? input.minAgeMs : undefined) ?? DEFAULT_MIN_AGE_MS;
  if (typeof keepLatest !== "number" || !Number.isSafeInteger(keepLatest) || keepLatest < 1) {
    throw new Error("policy.keepLatest must be a positive integer");
  }
  if (typeof minAgeMs !== "number" || !Number.isSafeInteger(minAgeMs) || minAgeMs < 0) {
    throw new Error("policy.minAgeMs must be a non-negative integer");
  }
  return {
    provider: input.provider,
    prefix,
    protectedReferences,
    keepLatest,
    minAgeMs,
  };
}

export function planCleanup(
  inventory: BaseSnapshot[],
  input: BaseSnapshotPolicyInput,
  nowMs = Date.now()
): CleanupPlan {
  const policy = validatePolicy(input);
  const pattern = managedNamePattern(policy);
  const managed = inventory.filter((snapshot) => pattern.test(snapshot.name));
  const seen = new Set<string>();
  for (const snapshot of managed) {
    if (!snapshot.id || seen.has(snapshot.id)) throw new Error("Invalid or duplicate snapshot ID");
    seen.add(snapshot.id);
  }
  const protectedReferences = new Set(policy.protectedReferences);
  // A mistyped ID or name would leave its intended artifact eligible for deletion.
  const managedReferences = new Set(managed.flatMap((snapshot) => [snapshot.id, snapshot.name]));
  const unmatched = [...protectedReferences].filter(
    (reference) => !managedReferences.has(reference)
  );
  if (unmatched.length) {
    throw new Error(
      `Protected references match no managed snapshot in inventory: ${unmatched.join(", ")}`
    );
  }
  const isProtected = (snapshot: BaseSnapshot) =>
    protectedReferences.has(snapshot.id) || protectedReferences.has(snapshot.name);
  const newest = new Set(
    managed
      .filter((snapshot) => snapshot.ready && Number.isFinite(snapshot.createdAtMs))
      .sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id))
      .slice(0, policy.keepLatest)
      .map((snapshot) => snapshot.id)
  );
  const result: CleanupPlan = { provider: policy.provider, keep: [], delete: [] };
  for (const snapshot of managed) {
    let reason: KeepReason | undefined;
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

interface CleanupReport extends CleanupPlan {
  apply: boolean;
  deleted: BaseSnapshotReference[];
}

interface PartialCleanupReport extends CleanupReport {
  failed: BaseSnapshotReference;
  /** Planned deletions that did not complete, starting with the failed one. */
  remaining: BaseSnapshotReference[];
}

/** A deletion failed mid-batch; the report records what was already deleted. */
export class CleanupDeletionError extends Error {
  readonly report: PartialCleanupReport;

  constructor(report: PartialCleanupReport, cause: unknown) {
    super(
      `Deleting ${report.failed.id} (${report.failed.name}) failed after ` +
        `${report.deleted.length} of ${report.delete.length} planned deletions: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause }
    );
    this.name = "CleanupDeletionError";
    this.report = report;
  }
}

export async function cleanup(
  client: BaseSnapshotClient,
  policy: BaseSnapshotPolicyInput,
  { apply = false, nowMs = Date.now() }: { apply?: boolean; nowMs?: number } = {}
): Promise<CleanupReport> {
  // Finish listing and validating every page before the first mutation.
  const plan = planCleanup(await client.list(), policy, nowMs);
  const deleted: BaseSnapshotReference[] = [];
  if (apply) {
    for (const snapshot of plan.delete) {
      try {
        await client.delete(snapshot);
      } catch (error) {
        const remaining = plan.delete.slice(deleted.length);
        throw new CleanupDeletionError(
          { ...plan, apply, deleted, failed: snapshot, remaining },
          error
        );
      }
      deleted.push(snapshot);
    }
  }
  return { ...plan, apply, deleted };
}
