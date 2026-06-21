import { describe, expect, it } from "vitest";
import { parseCreateSessionInput } from "./create-session-input";

function jsonRequest(body: unknown): Request {
  return new Request("http://internal/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("parseCreateSessionInput", () => {
  it("parses a valid session input with identity fields", async () => {
    const result = await parseCreateSessionInput(
      jsonRequest({
        repoOwner: "open-inspect",
        repoName: "background-agents",
        userId: "user-1",
        authProvider: "github",
        authUserId: "123",
        scmToken: "gho_token",
        scmTokenExpiresAt: 123456,
      })
    );

    expect(result).toEqual({
      ok: true,
      input: {
        repoOwner: "open-inspect",
        repoName: "background-agents",
        userId: "user-1",
        authProvider: "github",
        authUserId: "123",
        scmToken: "gho_token",
        scmTokenExpiresAt: 123456,
      },
    });
  });

  it("rejects a malformed partial session input", async () => {
    const result = await parseCreateSessionInput(jsonRequest({ repoOwner: "open-inspect" }));

    expect(result).toEqual({ ok: false, message: "Invalid session request body" });
  });

  it("rejects an invalid auth provider instead of preserving it", async () => {
    const result = await parseCreateSessionInput(
      jsonRequest({
        repoOwner: "open-inspect",
        repoName: "background-agents",
        authProvider: "evil",
        authUserId: "123",
      })
    );

    expect(result).toEqual({ ok: false, message: "Invalid session request body" });
  });
});
