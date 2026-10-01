import { describe, expect, it } from "vitest";
import { agentSessionWebhookSchema } from "./types";

function validAgentSessionWebhook() {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org-1",
    webhookId: "webhook-config-1",
    appUserId: "app-user-1",
    promptContext: "Implement the issue.",
    agentSession: {
      id: "agent-session-1",
      creatorId: "user-1",
      issue: {
        id: "issue-1",
        identifier: "ENG-1",
        title: "Fix bug",
        description: "Steps to reproduce",
        url: "https://linear.app/acme/issue/ENG-1/fix-bug",
        priority: 2,
        priorityLabel: "High",
        team: { id: "team-1", key: "ENG", name: "Engineering" },
        labels: [{ id: "label-1", name: "bug" }],
        assignee: { id: "user-1", name: "Ada" },
        project: { id: "project-1", name: "Q4" },
      },
      comment: { body: "Please handle this", userId: "user-1" },
    },
    agentActivity: {
      userId: "user-1",
      signal: "prompt",
      content: { type: "text", body: "Follow up" },
    },
  };
}

function minimalIssueWebhook() {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org-1",
    webhookId: "webhook-config-1",
    appUserId: "app-user-1",
    agentSession: {
      id: "agent-session-1",
      issue: {
        id: "issue-1",
        identifier: "ENG-1",
        title: "Fix bug",
        description: "Steps to reproduce",
        url: "https://linear.app/acme/issue/ENG-1/fix-bug",
        team: { id: "team-1", key: "ENG", name: "Engineering" },
        teamId: "team-1",
      },
    },
  };
}

describe("agentSessionWebhookSchema", () => {
  it("parses a valid AgentSessionEvent payload", () => {
    const result = agentSessionWebhookSchema.safeParse(validAgentSessionWebhook());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentSession.issue?.identifier).toBe("ENG-1");
    }
  });

  it("rejects malformed AgentSessionEvent payloads", () => {
    const payload = validAgentSessionWebhook();
    payload.agentSession.id = 123 as never;

    expect(agentSessionWebhookSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts Linear's minimal issue-bearing webhook payload", () => {
    const result = agentSessionWebhookSchema.safeParse(minimalIssueWebhook());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentSession.issue?.priority).toBeUndefined();
      expect(result.data.agentSession.issue?.priorityLabel).toBeUndefined();
    }
  });

  it("accepts nullable Linear fields that are optional in downstream handling", () => {
    const base = validAgentSessionWebhook();
    const payload = {
      ...base,
      agentSession: {
        ...base.agentSession,
        creatorId: null,
        issue: {
          ...base.agentSession.issue,
          description: null,
          labels: null,
          assignee: null,
          project: null,
        },
        comment: null,
      },
      agentActivity: null,
    };

    const result = agentSessionWebhookSchema.safeParse(payload);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentSession.issue?.description).toBeNull();
      expect(result.data.agentSession.issue?.labels).toBeUndefined();
      expect(result.data.agentSession.comment).toBeUndefined();
      expect(result.data.agentActivity).toBeUndefined();
    }
  });

  it("accepts prompted deliveries with null optional scalars", () => {
    const base = minimalIssueWebhook();
    const payload = {
      ...base,
      action: "prompted",
      promptContext: null,
      agentSession: {
        ...base.agentSession,
        comment: { body: "Original comment", userId: null },
      },
      agentActivity: {
        userId: null,
        signal: null,
        content: { type: null, body: "Follow up" },
      },
    };

    const result = agentSessionWebhookSchema.safeParse(payload);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.promptContext).toBeUndefined();
      expect(result.data.agentSession.comment?.userId).toBeUndefined();
      expect(result.data.agentActivity?.signal).toBeUndefined();
      expect(result.data.agentActivity?.userId).toBeUndefined();
      expect(result.data.agentActivity?.content?.type).toBeUndefined();
      expect(result.data.agentActivity?.content?.body).toBe("Follow up");
    }
  });
});
