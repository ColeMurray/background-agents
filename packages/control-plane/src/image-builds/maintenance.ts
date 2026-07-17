import { MAX_BUILD_TIMEOUT_SECONDS } from "@open-inspect/shared";

// Mirrors SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS in packages/modal-infra/src/sandbox/manager.py.
const SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS = 300;
// Mirrors BUILD_FUNCTION_TIMEOUT_MARGIN_SECONDS in packages/modal-infra/src/sandbox/manager.py.
const BUILD_FUNCTION_TIMEOUT_MARGIN_SECONDS = 300;

/**
 * Age past which a `building` row is provably dead and safe to fail: sized at
 * the longest possible build's worker lifetime so a long-but-live build is
 * never reaped. Modal is the worst case — sandbox lifetime is capped at
 * MAX_BUILD_TIMEOUT_SECONDS, and its build worker idles through the snapshot
 * budget plus a margin on top (build_function_timeout_seconds in
 * packages/modal-infra/src/sandbox/manager.py). Vercel and OpenComputer
 * ceilings sit at or under this; maintenance.test.ts pins all three, so a
 * provider lifetime bump past the threshold fails CI instead of live-failing
 * long builds. The clock starts at row registration (`created_at`), not
 * sandbox start, so provider queueing eats into the margin.
 */
export const DEFAULT_STALE_BUILD_MAX_AGE_MS =
  (MAX_BUILD_TIMEOUT_SECONDS +
    SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS +
    BUILD_FUNCTION_TIMEOUT_MARGIN_SECONDS) *
  1000;
