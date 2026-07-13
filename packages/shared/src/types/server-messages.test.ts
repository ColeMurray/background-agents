import { describe, expect, expectTypeOf, it } from "vitest";
import { serverMessageSchema } from "./server-messages";
import type { PullRequestSummary, Session } from "./sessions";

describe("artifact_updated server message", () => {
  const artifact = {
    id: "artifact-1",
    type: "pr",
    url: "https://github.com/acme/web/pull/7",
    metadata: { number: 7, lifecycleState: "merged", isDraft: false },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
  };

  it("parses artifact_updated mirroring artifact_created", () => {
    const parsed = serverMessageSchema.parse({ type: "artifact_updated", artifact });
    expect(parsed.type).toBe("artifact_updated");
    if (parsed.type === "artifact_updated") {
      expect(parsed.artifact.id).toBe("artifact-1");
      expect(parsed.artifact.updatedAt).toBe(1_700_000_005_000);
    }
  });

  it("still parses artifact_created (rolling compatibility)", () => {
    const parsed = serverMessageSchema.parse({ type: "artifact_created", artifact });
    expect(parsed.type).toBe("artifact_created");
  });

  it("rejects artifact_updated without an artifact", () => {
    expect(serverMessageSchema.safeParse({ type: "artifact_updated" }).success).toBe(false);
  });
});

describe("Session.pullRequestSummary contract", () => {
  it("is optional on the session list contract and counts by display status", () => {
    expectTypeOf<Session["pullRequestSummary"]>().toEqualTypeOf<PullRequestSummary | undefined>();
    const summary: PullRequestSummary = { total: 2, open: 1, draft: 0, merged: 1, closed: 0 };
    expect(summary.total).toBe(2);
  });
});
