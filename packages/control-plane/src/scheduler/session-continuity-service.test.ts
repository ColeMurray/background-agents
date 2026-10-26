import { describe, expect, it, vi } from "vitest";
import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import type { AutomationRow, ContinuableRunRow, HeldPromptRow } from "../db/automation-store";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger } from "../logger";
import type { Env } from "../types";
import type { ContinuationPolicy } from "./session-continuity";
import {
  SessionContinuityService,
  type SessionContinuityServiceDeps,
} from "./session-continuity-service";
import { DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS } from "@open-inspect/shared/types/automations";

const automation: AutomationRow = {
  id: "auto-1",
  name: "Follow up",
  instructions: "Run tests",
  trigger_type: "slack_event",
  schedule_cron: null,
  schedule_once_at: null,
  schedule_tz: "UTC",
  harness: "codex",
  model: "openai/gpt-5.4",
  reasoning_effort: null,
  enabled: 1,
  max_concurrent_runs: DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
  next_run_at: null,
  consecutive_failures: 0,
  created_by: "author-1",
  user_id: "user-1",
  owner_team_id: null,
  max_retries: 0,
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
  event_type: "message.posted",
  trigger_config: null,
  trigger_auth_data: null,
};
const run: ContinuableRunRow = {
  id: "run-1",
  automation_id: automation.id,
  invocation_id: "inv-1",
  session_id: null,
  status: "starting",
  skip_reason: null,
  failure_reason: null,
  scheduled_at: 0,
  started_at: null,
  completed_at: null,
  execution_deadline_at: null,
  created_at: 0,
  repo_owner: null,
  repo_name: null,
  repo_id: null,
  base_branch: null,
  environment_id: null,
  first_prompt_pending: 0,
  last_activity_at: 1_000,
  has_held_prompts: 0,
};
const authorization: EffectiveAuthorization = {
  userId: "user-1",
  suspendedAt: null,
  role: { id: "role-1", key: "member", name: "Member" },
  permissions: ["sessions.collaborate"],
};
const user = { userId: "user-1", authorId: "slack:U1" };
const heldPrompt: HeldPromptRow = {
  id: "held-1",
  run_id: run.id,
  actor_user_id: user.userId,
  actor_author_id: user.authorId,
  client_request_id: "held:held-1",
  prompt: JSON.stringify({ content: "Follow up", source: "slack" }),
  request_id: "delivery-1",
  created_at: 1_000,
  retry_at: 121_000,
};

function harness() {
  type Store = SessionContinuityServiceDeps["store"];
  const deps = {
    store: {
      deferHeldPrompts: vi.fn<Store["deferHeldPrompts"]>().mockResolvedValue(undefined),
      deleteHeldPrompt: vi.fn<Store["deleteHeldPrompt"]>().mockResolvedValue(undefined),
      deleteHeldPromptsForRun: vi.fn<Store["deleteHeldPromptsForRun"]>().mockResolvedValue(0),
      getHeldPrompts: vi.fn<Store["getHeldPrompts"]>().mockResolvedValue([]),
      getLatestContinuableRun: vi.fn<Store["getLatestContinuableRun"]>().mockResolvedValue(run),
      getRunsWithDueHeldPrompts: vi.fn<Store["getRunsWithDueHeldPrompts"]>().mockResolvedValue([]),
      getSessionRunsForContinuityKey: vi
        .fn<Store["getSessionRunsForContinuityKey"]>()
        .mockResolvedValue([]),
      holdPromptForLaunchingRun: vi
        .fn<Store["holdPromptForLaunchingRun"]>()
        .mockResolvedValue("held"),
      markRunFirstPromptQueued: vi
        .fn<Store["markRunFirstPromptQueued"]>()
        .mockResolvedValue(undefined),
    },
    authorization: {
      getEffectiveAuthorization: vi
        .fn<SessionContinuityServiceDeps["authorization"]["getEffectiveAuthorization"]>()
        .mockResolvedValue(authorization),
    },
    clock: { now: vi.fn(() => 1_000) },
    crypto: { generateId: vi.fn(() => "held-1") },
    db: {
      prepare: vi.fn<SqlDatabase["prepare"]>(() => {
        throw new Error("Unexpected database call");
      }),
      batch: vi.fn(async () => {
        throw new Error("Unexpected database call");
      }),
    },
    backgroundJobs: { submit: vi.fn() },
    env: {} as Env,
    log: createLogger("continuity-test", {}, "error"),
  } satisfies SessionContinuityServiceDeps;
  return { deps, service: new SessionContinuityService(deps) };
}

describe("SessionContinuityService dependencies", () => {
  it("resolves authority lazily and reads it afresh on each resolution", async () => {
    const { deps, service } = harness();
    expect(deps.authorization.getEffectiveAuthorization).not.toHaveBeenCalled();
    expect(deps.db.prepare).not.toHaveBeenCalled();
    expect(deps.clock.now).not.toHaveBeenCalled();
    expect(deps.crypto.generateId).not.toHaveBeenCalled();

    const actor = await service.resolveActor(user, "trace-1", "delivery-1");
    expect(actor).toMatchObject({
      ...user,
      context: {
        db: deps.db,
        executionCtx: deps.backgroundJobs,
        trace_id: "trace-1",
        request_id: "delivery-1",
        principal: { kind: "user", userId: user.userId },
        authorization,
      },
    });
    deps.authorization.getEffectiveAuthorization.mockResolvedValue({
      ...authorization,
      permissions: [],
    });
    await expect(service.resolveActor(user, "trace-2", "delivery-2")).resolves.toBeNull();
    expect(deps.authorization.getEffectiveAuthorization.mock.calls).toEqual([
      [user.userId],
      [user.userId],
    ]);
  });

  it.each([
    { ...authorization, suspendedAt: 1_000 },
    { ...authorization, permissions: [] },
  ])("rejects actors without current collaboration authority (%#)", async (denied) => {
    const { deps, service } = harness();
    deps.authorization.getEffectiveAuthorization.mockResolvedValue(denied);
    await expect(service.resolveActor(user, "trace", "request")).resolves.toBeNull();
  });

  it("propagates authority lookup errors to the caller's delivery policy", async () => {
    const { deps, service } = harness();
    const error = new Error("Authority unavailable");
    deps.authorization.getEffectiveAuthorization.mockRejectedValue(error);
    await expect(service.resolveActor(user, "trace", "request")).rejects.toBe(error);
  });

  it.each([undefined, "webhook:delivery-1"])(
    "holds a prompt with injected ID and time, preserving request ID %s",
    async (requestId) => {
      const { deps, service } = harness();
      const actor = await service.resolveActor(user, "trace", "delivery-1");
      const body = { content: "Follow up", source: "slack" as const, clientRequestId: requestId };
      const policy = {
        source: "slack" as const,
        resolveActor: vi.fn().mockResolvedValue(actor),
        buildPrompt: vi
          .fn()
          .mockResolvedValue({ body, ctx: { trace_id: "trace", request_id: "delivery-1" } }),
        acceptDelivery: vi.fn().mockResolvedValue(undefined),
      } satisfies ContinuationPolicy;
      deps.clock.now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_001);

      await expect(service.continueSession(automation, "thread", 1_000, policy)).resolves.toEqual({
        kind: "steered",
        invocationId: run.invocation_id,
      });

      expect(policy.buildPrompt).toHaveBeenCalledExactlyOnceWith(run, actor, automation);
      const clientRequestId = requestId ?? "held:held-1";
      expect(deps.store.holdPromptForLaunchingRun).toHaveBeenCalledExactlyOnceWith({
        ...heldPrompt,
        client_request_id: clientRequestId,
        prompt: JSON.stringify({ ...body, clientRequestId }),
        retry_at: 121_001,
      });
      expect(deps.crypto.generateId).toHaveBeenCalledOnce();
      expect(deps.clock.now).toHaveBeenCalledTimes(2);
      expect(policy.acceptDelivery).toHaveBeenCalledExactlyOnceWith(run);
      expect(deps.store.holdPromptForLaunchingRun.mock.invocationCallOrder[0]).toBeLessThan(
        policy.acceptDelivery.mock.invocationCallOrder[0]
      );
    }
  );

  it("rechecks authority before releasing held prompts and drops a revoked actor's prompt", async () => {
    const { deps, service } = harness();
    await expect(service.resolveActor(user, "trace", "delivery-1")).resolves.not.toBeNull();
    deps.authorization.getEffectiveAuthorization.mockResolvedValue({
      ...authorization,
      permissions: [],
    });
    deps.store.getHeldPrompts.mockResolvedValueOnce([heldPrompt]);

    await expect(
      service.releaseHeldPrompts({ ...run, status: "running", session_id: "session-1" })
    ).resolves.toBe(true);
    expect(deps.authorization.getEffectiveAuthorization).toHaveBeenCalledTimes(2);
    expect(deps.store.deleteHeldPrompt).toHaveBeenCalledExactlyOnceWith(heldPrompt.id);
    // A revoked actor is rejected before target-session admission or transport needs the DB.
    expect(deps.db.prepare).not.toHaveBeenCalled();
  });

  it("retains held prompts when current authority cannot be checked", async () => {
    const { deps, service } = harness();
    deps.authorization.getEffectiveAuthorization.mockRejectedValue(new Error("D1 unavailable"));
    deps.store.getHeldPrompts.mockResolvedValueOnce([heldPrompt]);

    await expect(
      service.releaseHeldPrompts({ ...run, status: "running", session_id: "session-1" })
    ).resolves.toBe(false);
    expect(deps.store.deleteHeldPrompt).not.toHaveBeenCalled();
  });
});
