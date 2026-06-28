import { describe, expect, it } from "vitest";
import { parseCreateSessionInput } from "./create-session-input";

function jsonRequest(body: unknown): Request {
  return new Request("http://internal/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string): Request {
  return new Request("http://internal/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
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

  it("rejects partial repository metadata", async () => {
    const result = await parseCreateSessionInput(jsonRequest({ repoOwner: "open-inspect" }));

    expect(result).toEqual({ ok: false, message: "Invalid session request body" });
  });

  it("keeps no-repository requests available for route-level validation", async () => {
    const result = await parseCreateSessionInput(
      jsonRequest({
        title: "No repository automation run",
      })
    );

    expect(result).toEqual({
      ok: true,
      input: {
        title: "No repository automation run",
      },
    });
  });

  it("rejects invalid JSON without throwing", async () => {
    const result = await parseCreateSessionInput(rawRequest("{"));

    expect(result).toEqual({ ok: false, message: "Invalid JSON body" });
  });

  it.each([null, [], "repo", 123, true])("rejects non-object JSON body %s", async (body) => {
    const result = await parseCreateSessionInput(jsonRequest(body));

    expect(result).toEqual({ ok: false, message: "JSON body must be an object" });
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
