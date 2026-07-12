import { describe, expect, it } from "vitest";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import type { SessionArtifact } from "@open-inspect/shared";
import { cacheKeysToRevalidate } from "./cache";

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

describe("cacheKeysToRevalidate", () => {
  it("revalidates the session list for PR artifact creates and updates", () => {
    expect(
      cacheKeysToRevalidate({ type: "artifact_created", artifact: artifact("pr") }, SESSION_ID)
    ).toEqual([isUnarchivedSessionListKey]);
    expect(
      cacheKeysToRevalidate({ type: "artifact_updated", artifact: artifact("pr") }, SESSION_ID)
    ).toEqual([isUnarchivedSessionListKey]);
  });

  it("does not revalidate for non-PR artifacts", () => {
    expect(
      cacheKeysToRevalidate(
        { type: "artifact_created", artifact: artifact("screenshot") },
        SESSION_ID
      )
    ).toEqual([]);
  });

  it("revalidates the session list on a non-empty title", () => {
    expect(
      cacheKeysToRevalidate({ type: "session_title", title: "New title" }, SESSION_ID)
    ).toEqual([isUnarchivedSessionListKey]);
    expect(cacheKeysToRevalidate({ type: "session_title", title: "" }, SESSION_ID)).toEqual([]);
  });

  it("revalidates the session list on status changes", () => {
    expect(
      cacheKeysToRevalidate({ type: "session_status", status: "completed" }, SESSION_ID)
    ).toEqual([isUnarchivedSessionListKey]);
  });

  it("revalidates the child list and the session list on child session updates", () => {
    expect(
      cacheKeysToRevalidate(
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

  it("returns nothing for view-only messages", () => {
    expect(cacheKeysToRevalidate({ type: "pong", timestamp: 1 }, SESSION_ID)).toEqual([]);
    expect(
      cacheKeysToRevalidate({ type: "session_branch", branchName: "feature/x" }, SESSION_ID)
    ).toEqual([]);
    expect(cacheKeysToRevalidate({ type: "sandbox_ready" }, SESSION_ID)).toEqual([]);
  });
});
