import { describe, expect, it, vi } from "vitest";
import type { SessionRepository } from "../repository";
import type { PlanRow } from "../types";
import { MAX_PLAN_CONTENT_BYTES, PlanService } from "./plan.service";

function createService(now = 1_700_000_000_000) {
  let nextId = 0;
  const repository = {
    savePlan: vi.fn(),
    getCurrentPlan: vi.fn().mockReturnValue(null),
    listPlans: vi.fn(),
    getSession: vi.fn().mockReturnValue({ plan_mode: 0, plan_approval_status: null }),
    updatePlanApprovalStatus: vi.fn(),
    snapshotPlanCost: vi.fn(),
    updateSessionModel: vi.fn(),
    updateSessionReasoningEffort: vi.fn(),
    createEvent: vi.fn(),
  } as unknown as SessionRepository;

  return {
    service: new PlanService({
      repository,
      generateId: () => `plan-${++nextId}`,
      now: () => now,
    }),
    repository,
  };
}

describe("PlanService.savePlan", () => {
  it("persists trimmed content and returns the row mapped to a response", () => {
    const { service, repository } = createService(1234);
    vi.mocked(repository.savePlan).mockImplementation((data) => ({
      id: data.id,
      version: 1,
      content: data.content,
      created_by_author_id: data.createdByAuthorId,
      created_by_message_id: data.createdByMessageId,
      source: data.source,
      created_at: data.createdAt,
    }));

    const response = service.savePlan({
      content: "  step 1\nstep 2  ",
      authorId: "participant-1",
      messageId: "msg-1",
      source: "agent",
    });

    expect(repository.savePlan).toHaveBeenCalledWith({
      id: "plan-1",
      content: "step 1\nstep 2",
      createdByAuthorId: "participant-1",
      createdByMessageId: "msg-1",
      source: "agent",
      createdAt: 1234,
    });
    expect(response).toEqual({
      plan: {
        id: "plan-1",
        version: 1,
        content: "step 1\nstep 2",
        createdByAuthorId: "participant-1",
        createdByMessageId: "msg-1",
        source: "agent",
        createdAt: 1234,
      },
      approvalGated: false,
      deduped: false,
    });
  });

  it("defaults source to 'api' when omitted", () => {
    const { service, repository } = createService();
    vi.mocked(repository.savePlan).mockImplementation(
      (data) =>
        ({
          id: data.id,
          version: 1,
          content: data.content,
          created_by_author_id: null,
          created_by_message_id: null,
          source: data.source,
          created_at: data.createdAt,
        }) as PlanRow
    );

    service.savePlan({ content: "plan body" });

    expect(repository.savePlan).toHaveBeenCalledWith(
      expect.objectContaining({ source: "api", createdByAuthorId: null, createdByMessageId: null })
    );
  });

  it("rejects empty content", () => {
    const { service, repository } = createService();
    expect(() => service.savePlan({ content: "   " })).toThrow(/empty/i);
    expect(repository.savePlan).not.toHaveBeenCalled();
  });

  it("does not dedup when messageId is null even with identical content", () => {
    // Regression test for CodeRabbit #671 item 1.4: messageId is the dedup
    // token, so a null messageId means two identical-body events are
    // legitimately distinct saves and must each produce a new version.
    const { service, repository } = createService();
    vi.mocked(repository.getCurrentPlan).mockReturnValue({
      id: "plan-existing",
      version: 3,
      content: "same body",
      created_by_author_id: null,
      created_by_message_id: null,
      source: "api",
      created_at: 1000,
    } as PlanRow);
    vi.mocked(repository.savePlan).mockImplementation(
      (data) =>
        ({
          id: data.id,
          version: 4,
          content: data.content,
          created_by_author_id: data.createdByAuthorId,
          created_by_message_id: data.createdByMessageId,
          source: data.source,
          created_at: data.createdAt,
        }) as PlanRow
    );

    const response = service.savePlan({ content: "same body" }); // messageId omitted → null

    expect(repository.savePlan).toHaveBeenCalledTimes(1);
    expect(response.deduped).toBe(false);
  });

  it("accepts content exactly at MAX_PLAN_CONTENT_BYTES", () => {
    const { service, repository } = createService();
    vi.mocked(repository.savePlan).mockImplementation(
      (data) =>
        ({
          id: data.id,
          version: 1,
          content: data.content,
          created_by_author_id: null,
          created_by_message_id: null,
          source: data.source,
          created_at: data.createdAt,
        }) as PlanRow
    );

    const body = "a".repeat(MAX_PLAN_CONTENT_BYTES);
    expect(() => service.savePlan({ content: body })).not.toThrow();
    expect(repository.savePlan).toHaveBeenCalledTimes(1);
  });

  it("rejects content over MAX_PLAN_CONTENT_BYTES", () => {
    const { service, repository } = createService();
    const body = "a".repeat(MAX_PLAN_CONTENT_BYTES + 1);
    expect(() => service.savePlan({ content: body })).toThrow(/exceeds/i);
    expect(repository.savePlan).not.toHaveBeenCalled();
  });
});

describe("PlanService.getCurrentPlan", () => {
  it("returns null when no plan exists", () => {
    const { service, repository } = createService();
    vi.mocked(repository.getCurrentPlan).mockReturnValue(null);
    expect(service.getCurrentPlan()).toBeNull();
  });

  it("maps the repository row to a response", () => {
    const { service, repository } = createService();
    vi.mocked(repository.getCurrentPlan).mockReturnValue({
      id: "p1",
      version: 3,
      content: "current plan",
      created_by_author_id: "author-x",
      created_by_message_id: "msg-x",
      source: "web",
      created_at: 99,
    });
    expect(service.getCurrentPlan()).toEqual({
      id: "p1",
      version: 3,
      content: "current plan",
      createdByAuthorId: "author-x",
      createdByMessageId: "msg-x",
      source: "web",
      createdAt: 99,
    });
  });
});

describe("PlanService.approvePlan", () => {
  it("snapshots total_cost into plan_cost_snapshot when approving", () => {
    const { service, repository } = createService(5000);
    vi.mocked(repository.getSession).mockReturnValue({
      plan_mode: 1,
      plan_approval_status: "awaiting_approval",
    } as never);
    vi.mocked(repository.getCurrentPlan).mockReturnValue({
      id: "p1",
      version: 1,
      content: "plan",
      created_by_author_id: null,
      created_by_message_id: null,
      source: "api",
      created_at: 100,
    });

    service.approvePlan();

    expect(repository.updatePlanApprovalStatus).toHaveBeenCalledWith("approved", 5000);
    expect(repository.snapshotPlanCost).toHaveBeenCalledWith(5000);
  });
});

describe("PlanService.listPlans", () => {
  it("forwards the limit and maps rows", () => {
    const { service, repository } = createService();
    vi.mocked(repository.listPlans).mockReturnValue([
      {
        id: "p2",
        version: 2,
        content: "v2",
        created_by_author_id: null,
        created_by_message_id: null,
        source: "api",
        created_at: 200,
      },
      {
        id: "p1",
        version: 1,
        content: "v1",
        created_by_author_id: null,
        created_by_message_id: null,
        source: "api",
        created_at: 100,
      },
    ]);

    const result = service.listPlans(5);
    expect(repository.listPlans).toHaveBeenCalledWith(5);
    expect(result).toHaveLength(2);
    expect(result[0].version).toBe(2);
  });
});
