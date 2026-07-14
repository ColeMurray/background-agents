import { describe, expect, it } from "vitest";
import { isUnarchivedSessionListKey, SIDEBAR_INFINITE_KEYS } from "@/lib/session-list";
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
  const listKeys = [isUnarchivedSessionListKey, ...SIDEBAR_INFINITE_KEYS];
  it("revalidates the session list for PR artifact creates and updates", () => {
    expect(
      swrKeysToRevalidate({ type: "artifact_created", artifact: artifact("pr") }, SESSION_ID)
    ).toEqual(listKeys);
    expect(
      swrKeysToRevalidate({ type: "artifact_updated", artifact: artifact("pr") }, SESSION_ID)
    ).toEqual(listKeys);
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
    expect(swrKeysToRevalidate({ type: "session_title", title: "New title" }, SESSION_ID)).toEqual(
      listKeys
    );
    expect(swrKeysToRevalidate({ type: "session_title", title: "" }, SESSION_ID)).toEqual([]);
  });

  it("revalidates the session list on status changes", () => {
    expect(
      swrKeysToRevalidate({ type: "session_status", status: "completed" }, SESSION_ID)
    ).toEqual(listKeys);
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
    ).toEqual([`/api/sessions/${SESSION_ID}/children`, ...listKeys]);
  });

  it("returns nothing for view-only messages", () => {
    expect(swrKeysToRevalidate({ type: "pong", timestamp: 1 }, SESSION_ID)).toEqual([]);
    expect(
      swrKeysToRevalidate({ type: "session_branch", branchName: "feature/x" }, SESSION_ID)
    ).toEqual([]);
    expect(swrKeysToRevalidate({ type: "sandbox_ready" }, SESSION_ID)).toEqual([]);
  });
});
