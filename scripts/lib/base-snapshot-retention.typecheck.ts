import { cleanup, planCleanup, validatePolicy } from "./base-snapshot-retention.ts";
import type { BaseSnapshot, BaseSnapshotClient } from "./base-snapshot-retention.ts";

// Compile-only regressions: these errors must not disappear into unchecked JS or any.
declare const snapshot: BaseSnapshot;
declare const client: BaseSnapshotClient;
declare const deleteById: (id: string) => Promise<void>;
declare const input: unknown;
const policy = validatePolicy(input);

planCleanup([snapshot], policy);
cleanup(client, policy);

// @ts-expect-error Inventory timestamps use milliseconds, not provider strings.
planCleanup([{ ...snapshot, createdAtMs: "2026-01-01" }], policy);
// @ts-expect-error Raw policy input must be validated at the JSON boundary.
planCleanup([snapshot], input);
// @ts-expect-error Deletion requires the snapshot reference, not just its ID.
cleanup({ ...client, delete: deleteById }, policy);
// @ts-expect-error Apply is an explicit boolean, not a truthy string.
cleanup(client, policy, { apply: "false" });
// @ts-expect-error Planned deletion references retain string IDs.
const id: number = planCleanup([snapshot], policy).delete[0].id;
void id;
