/** Row builders shared by the automation invocation integration suites. */

import { DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS } from "@open-inspect/shared/types/automations";
import type {
  AutomationInvocationRow,
  AutomationRow,
  AutomationRunRow,
} from "../../src/db/automation-store";

export function makeAutomation(overrides?: Partial<AutomationRow>): AutomationRow {
  const now = Date.now();
  return {
    id: `auto-${Math.random().toString(36).slice(2, 8)}`,
    owner_team_id: null,
    name: "Test Automation",
    instructions: "Run tests",
    trigger_type: "schedule",
    schedule_cron: "0 9 * * *",
    schedule_tz: "UTC",
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    enabled: 1,
    max_concurrent_runs: DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
    next_run_at: now + 86_400_000,
    consecutive_failures: 0,
    created_by: "user-1",
    user_id: "user-1",
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    ...overrides,
  };
}

export function makeInvocation(
  automationId: string,
  overrides?: Partial<AutomationInvocationRow>
): AutomationInvocationRow {
  const now = Date.now();
  return {
    id: `inv-${Math.random().toString(36).slice(2, 10)}`,
    automation_id: automationId,
    source: "manual",
    scheduled_at: null,
    trigger_key: null,
    concurrency_key: null,
    trigger_metadata: null,
    skip_reason: null,
    failure_counted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function makeChild(
  automationId: string,
  overrides?: Partial<AutomationRunRow>
): AutomationRunRow {
  const now = Date.now();
  return {
    id: `run-${Math.random().toString(36).slice(2, 10)}`,
    automation_id: automationId,
    invocation_id: `inv-child-${Math.random().toString(36).slice(2, 10)}`,
    session_id: null,
    status: "starting",
    skip_reason: null,
    failure_reason: null,
    scheduled_at: now,
    started_at: null,
    execution_deadline_at: null,
    completed_at: null,
    created_at: now,
    repo_owner: null,
    repo_name: null,
    repo_id: null,
    base_branch: null,
    environment_id: null,
    ...overrides,
  };
}
