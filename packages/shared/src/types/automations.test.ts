import { describe, expect, it } from "vitest";
import { listAutomationsPageResponseSchema } from "./automations";

const automation = {
  id: "auto-1",
  name: "Daily sync",
  instructions: "Run the sync",
  triggerType: "schedule",
  scheduleCron: "0 9 * * *",
  scheduleTz: "UTC",
  model: "anthropic/claude-sonnet-4-6",
  reasoningEffort: null,
  enabled: true,
  nextRunAt: 123,
  consecutiveFailures: 0,
  createdBy: "user-1",
  createdAt: 1,
  updatedAt: 2,
  deletedAt: null,
  eventType: null,
  triggerConfig: { conditions: [] },
  repositories: [{ repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" }],
  environmentIds: [],
};

describe("listAutomationsPageResponseSchema", () => {
  it("accepts a valid cursor page", () => {
    expect(
      listAutomationsPageResponseSchema.parse({
        automations: [automation],
        hasMore: true,
        nextCursor: "123:auto-1",
      })
    ).toMatchObject({ hasMore: true, nextCursor: "123:auto-1" });
  });

  it("rejects contradictory pagination", () => {
    expect(
      listAutomationsPageResponseSchema.safeParse({
        automations: [automation],
        hasMore: true,
        nextCursor: null,
      }).success
    ).toBe(false);
  });

  it("rejects malformed automation and trigger-condition records", () => {
    expect(
      listAutomationsPageResponseSchema.safeParse({
        automations: [
          {
            ...automation,
            enabled: "yes",
            triggerConfig: {
              conditions: [{ type: "branch", operator: "invalid", value: ["main"] }],
            },
          },
        ],
        hasMore: false,
        nextCursor: null,
      }).success
    ).toBe(false);
  });
});
