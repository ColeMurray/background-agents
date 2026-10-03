import { describe, expect, it } from "vitest";
import {
  linearCallbackContextSchema,
  linearCompletionCallbackSchema,
  linearStartCallbackSchema,
  linearToolCallCallbackSchema,
} from "./session-api";

const legacyContext = {
  source: "linear",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "anthropic/claude-haiku-4-5",
};

describe("Linear callback channel context", () => {
  it.each([false, true])(
    "preserves the external team with transitionIssueOnStart=%s",
    (transitionIssueOnStart) => {
      const context = {
        ...legacyContext,
        organizationId: "org-1",
        appUserId: "app-user-1",
        transitionIssueOnStart,
        linearTeamId: "external-team-1",
      };

      expect(linearCallbackContextSchema.parse(context)).toEqual(context);
      const callback = {
        sessionId: "session-1",
        messageId: "message-1",
        timestamp: 123,
        signature: "signature",
        context,
      };
      expect(linearStartCallbackSchema.parse(callback).context.linearTeamId).toBe(
        "external-team-1"
      );
      expect(
        linearCompletionCallbackSchema.parse({ ...callback, success: true }).context.linearTeamId
      ).toBe("external-team-1");
      expect(
        linearToolCallCallbackSchema.parse({
          sessionId: "session-1",
          timestamp: 123,
          signature: "signature",
          context,
          tool: "bash",
          args: {},
          callId: "call-1",
        }).context.linearTeamId
      ).toBe("external-team-1");
    }
  );

  it("accepts persisted contexts that predate linearTeamId", () => {
    expect(linearCallbackContextSchema.parse(legacyContext)).toEqual(legacyContext);
    expect(
      linearCompletionCallbackSchema.safeParse({
        sessionId: "session-1",
        messageId: "message-1",
        success: true,
        timestamp: 123,
        signature: "signature",
        context: legacyContext,
      }).success
    ).toBe(true);
  });

  it.each(["", " \t ", null, 123])("rejects an invalid external team ID: %s", (linearTeamId) => {
    expect(linearCallbackContextSchema.safeParse({ ...legacyContext, linearTeamId }).success).toBe(
      false
    );
  });

  it("does not accept an internal owner teamId as callback channel context", () => {
    expect(
      linearCallbackContextSchema.safeParse({ ...legacyContext, teamId: "internal-team-1" }).success
    ).toBe(false);
  });
});
