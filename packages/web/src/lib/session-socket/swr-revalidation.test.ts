import { describe, expect, it } from "vitest";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import type { SessionArtifact } from "@open-inspect/shared/types/artifacts";
import { swrKeysToRevalidate } from "./swr-revalidation";

const SESSION_ID = "session-1";

function artifact(type: SessionArtifact["type"]): SessionArtifact {
  return {
    id: `artifact-${type}-1`,
    type,
    url: "https://example.com",
    metadata: null,
    createdAt: 1,
  };
}

describe("swrKeysToRevalidate", () => {
  it("revalidates the session list for PR artifact creates and updates", () => {
    expect(
      swrKeysToRevalidate({ type: "artifact_created", artifact: artifact("pr") }, SESSION_ID)
    ).toEqual([isUnarchivedSessionListKey]);
    expect(
      swrKeysToRevalidate({ type: "artifact_updated", artifact: artifact("pr") }, SESSION_ID)
    ).toEqual([isUnarchivedSessionListKey]);
  });

  it("does not revalidate for non-PR artifacts", () => {
    expect(
      swrKeysToRevalidate(
        { type: "artifact_created", artifact: artifact("screenshot") },
        SESSION_ID
      )
    ).toEqual([]);
  });

  it("revalidates the session list on a non-empty title", () => {
    expect(swrKeysToRevalidate({ type: "session_title", title: "New title" }, SESSION_ID)).toEqual([
      isUnarchivedSessionListKey,
    ]);
    expect(swrKeysToRevalidate({ type: "session_title", title: "" }, SESSION_ID)).toEqual([]);
  });

  it("revalidates the session list on status changes", () => {
    expect(
      swrKeysToRevalidate({ type: "session_status", status: "completed" }, SESSION_ID)
    ).toEqual([isUnarchivedSessionListKey]);
  });

  it("revalidates the child list and the session list on child session updates", () => {
    expect(
      swrKeysToRevalidate(
        {
          type: "child_session_update",
          childSessionId: "child-1",
          status: "active",
          title: null,
        },
        SESSION_ID
      )
    ).toEqual([`/api/sessions/${SESSION_ID}/children`, isUnarchivedSessionListKey]);
  });

  it("revalidates the canonical diff manifest on diff state changes", () => {
    expect(
      swrKeysToRevalidate(
        {
          type: "diff_state_changed",
          revisionId: "revision-2",
          updatedAt: 200,
        },
        SESSION_ID
      )
    ).toEqual([`/api/sessions/${SESSION_ID}/diff`]);
  });

  it("revalidates client-only data when the authoritative snapshot arrives", () => {
    expect(
      swrKeysToRevalidate(
        {
          type: "subscribed",
          session: {
            id: SESSION_ID,
            title: null,
            repoOwner: null,
            repoName: null,
            baseBranch: null,
            branchName: null,
            status: "active",
            sandboxStatus: "ready",
            messageCount: 0,
            createdAt: 1,
          },
          artifacts: [],
          participantId: "participant-1",
          participant: { participantId: "participant-1", name: "User" },
          timeline: { events: [], hasMore: false, cursor: null },
        },
        SESSION_ID
      )
    ).toEqual([
      `/api/sessions/${SESSION_ID}/diff`,
      `/api/sessions/${SESSION_ID}/children`,
      `/api/sessions/${SESSION_ID}/participant-profiles`,
    ]);
  });

  it("returns nothing for view-only messages", () => {
    expect(swrKeysToRevalidate({ type: "pong", timestamp: 1 }, SESSION_ID)).toEqual([]);
    expect(
      swrKeysToRevalidate({ type: "session_branch", branchName: "feature/x" }, SESSION_ID)
    ).toEqual([]);
    expect(swrKeysToRevalidate({ type: "sandbox_ready" }, SESSION_ID)).toEqual([]);
  });
});
