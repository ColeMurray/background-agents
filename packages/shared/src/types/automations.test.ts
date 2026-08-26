import { describe, expect, it } from "vitest";
import {
  createAutomationRequestSchema,
  listAutomationsResponseSchema,
  updateAutomationRequestSchema,
} from "./automations";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

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
  providerSelections: {},
  recentExecutions: [],
};

describe("listAutomationsResponseSchema", () => {
  it("accepts a valid cursor page", () => {
    expect(
      listAutomationsResponseSchema.parse({
        automations: [automation],
        hasMore: true,
        nextCursor: "123:auto-1",
      })
    ).toMatchObject({ hasMore: true, nextCursor: "123:auto-1" });
  });

  it("rejects contradictory pagination", () => {
    expect(
      listAutomationsResponseSchema.safeParse({
        automations: [automation],
        hasMore: true,
        nextCursor: null,
      }).success
    ).toBe(false);
  });

  it("rejects malformed automation records", () => {
    expect(
      listAutomationsResponseSchema.safeParse({
        automations: [
          {
            ...automation,
            enabled: "yes",
          },
        ],
        hasMore: false,
        nextCursor: null,
      }).success
    ).toBe(false);
  });

  it("validates recent execution summaries", () => {
    const result = listAutomationsResponseSchema.parse({
      automations: [
        {
          ...automation,
          recentExecutions: [{ id: "inv-1", status: "partial_failed", createdAt: 123 }],
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    expect(result.automations[0].recentExecutions).toEqual([
      { id: "inv-1", status: "partial_failed", createdAt: 123 },
    ]);
  });

  it("rejects malformed trigger-condition records", () => {
    expect(
      listAutomationsResponseSchema.safeParse({
        automations: [
          {
            ...automation,
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

describe("automation provider selection contracts", () => {
  it("accepts complete create selections and returns selections in responses", () => {
    expect(
      createAutomationRequestSchema.safeParse({
        name: "Daily sync",
        instructions: "Run the sync",
        providerSelections: {
          openai: { mode: "provider_account", accountId: ACCOUNT_ID },
          xai: { mode: "api_key" },
        },
      }).success
    ).toBe(true);
    expect(
      listAutomationsResponseSchema.safeParse({
        automations: [automation],
        hasMore: false,
        nextCursor: null,
      }).success
    ).toBe(true);
  });

  it("distinguishes omitted patch selections from an explicit clear", () => {
    expect(updateAutomationRequestSchema.parse({ name: "Renamed" })).not.toHaveProperty(
      "providerSelections"
    );
    expect(updateAutomationRequestSchema.parse({ providerSelections: {} })).toEqual({
      providerSelections: {},
    });
  });

  it("rejects unknown providers in create, update, and response records", () => {
    const providerSelections = { anthropic: { mode: "api_key" } };
    expect(
      createAutomationRequestSchema.safeParse({
        name: "Daily sync",
        instructions: "Run the sync",
        providerSelections,
      }).success
    ).toBe(false);
    expect(updateAutomationRequestSchema.safeParse({ providerSelections }).success).toBe(false);
    expect(
      listAutomationsResponseSchema.safeParse({
        automations: [{ ...automation, providerSelections }],
        hasMore: false,
        nextCursor: null,
      }).success
    ).toBe(false);
  });
});
