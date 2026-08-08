import { describe, expect, it } from "vitest";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import type { SessionArtifact } from "@open-inspect/shared";
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

  it("revalidates missed client-only data when V2 synchronization becomes ready", () => {
    const encodedSessionId = "session%2Fone";
    expect(
      swrKeysToRevalidate(
        {
          type: "session_ready",
          sessionId: SESSION_ID,
          participantId: "participant-1",
          appliedRevision: 4,
        },
        SESSION_ID
      )
    ).toEqual([
      `/api/sessions/${SESSION_ID}/diff`,
      `/api/sessions/${SESSION_ID}/children`,
      `/api/sessions/${SESSION_ID}/participant-profiles`,
      `/api/sessions/${SESSION_ID}/access`,
    ]);
    expect(swrKeysToRevalidate({ type: "session_access_changed" }, SESSION_ID)).toEqual([
      `/api/sessions/${SESSION_ID}/access`,
    ]);
    expect(swrKeysToRevalidate({ type: "session_access_changed" }, "session/one")).toEqual([
      `/api/sessions/${encodedSessionId}/access`,
    ]);
  });

  it("revalidates the session list for relevant V2 state deltas", () => {
    expect(
      swrKeysToRevalidate(
        {
          type: "session_delta",
          revision: 4,
          delta: { operations: [{ type: "state_patch", patch: { title: "Updated" } }] },
        },
        SESSION_ID
      )
    ).toEqual([isUnarchivedSessionListKey]);
  });

  it("returns nothing for view-only messages", () => {
    expect(swrKeysToRevalidate({ type: "pong", timestamp: 1 }, SESSION_ID)).toEqual([]);
    expect(
      swrKeysToRevalidate({ type: "session_branch", branchName: "feature/x" }, SESSION_ID)
    ).toEqual([]);
    expect(swrKeysToRevalidate({ type: "sandbox_ready" }, SESSION_ID)).toEqual([]);
  });
});
