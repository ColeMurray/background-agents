import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const smoke = readFileSync(new URL("./compose-smoke.sh", import.meta.url), "utf8");
const replicationCheck = smoke.match(/log "replication"\n([\s\S]+?)\nlog "clean shutdown"/)?.[1];
assert.ok(replicationCheck, "replication check must remain independently testable");
const TEST_TIMEOUT_MS = 5_000;

function runReplicationCheck({ snapshotReady = false, completesAfterPoll = false } = {}) {
  return spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
       SECONDS=0
       SNAPSHOT_READY=${Number(snapshotReady)}
       COMPLETES_AFTER_POLL=${Number(completesAfterPoll)}
       POLLS=0
       COMPOSE=(compose_logs)
       compose_logs() {
         if [ "$SNAPSHOT_READY" = 1 ]; then
           printf '%s\\n' 'snapshot written'
         else
           printf '%s\\n' 'initializing replica'
         fi
       }
       fail() { printf 'FAIL: %s\\n' "$1" >&2; exit 1; }
       sleep() {
         POLLS=$((POLLS + 1))
         [ "$POLLS" -lt 5 ] || fail 'replication wait exceeded its deadline'
         if [ "$COMPLETES_AFTER_POLL" = 1 ]; then
           SNAPSHOT_READY=1
           SECONDS=$((SECONDS + 1))
         else
           SECONDS=$((SECONDS + 1000))
         fi
       }
       trap 'printf "polls=%s\\n" "$POLLS"' EXIT
       ${replicationCheck}`,
    ],
    { encoding: "utf8", timeout: TEST_TIMEOUT_MS }
  );
}

test("replication succeeds without waiting when the snapshot is already written", () => {
  const result = runReplicationCheck({ snapshotReady: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /polls=0/);
});

test("replication waits for a delayed first snapshot independently of scheduler timing", () => {
  const result = runReplicationCheck({ completesAfterPoll: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /polls=1/);
});

test("replication fails within its deadline when no snapshot is written", () => {
  const result = runReplicationCheck();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Litestream never wrote a snapshot/);
  assert.match(result.stdout, /polls=1/);
});
