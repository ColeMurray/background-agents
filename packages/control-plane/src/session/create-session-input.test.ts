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
  it("parses a valid session input with display identity fields", async () => {
    const fields = {
      repoOwner: "open-inspect",
      repoName: "background-agents",
      scmLogin: "ada",
      scmName: "Ada Lovelace",
      scmEmail: "ada@example.com",
      actorDisplayName: "Ada Lovelace",
      actorEmail: "ada@example.com",
      actorAvatarUrl: "https://avatars.example.com/ada.png",
    };
    const result = await parseCreateSessionInput(jsonRequest(fields));

    expect(result).toEqual({ ok: true, input: fields, raw: fields });
  });

  it("strips legacy identity fields from input while preserving them in raw", async () => {
    const legacyBody = {
      repoOwner: "open-inspect",
      repoName: "background-agents",
      userId: "user-1",
      spawnSource: "user",
      authProvider: "github",
      authUserId: "123",
      scmToken: "gho_token",
      scmTokenExpiresAt: 123456,
    };
    const result = await parseCreateSessionInput(jsonRequest(legacyBody));

    // Identity/credential fields are no longer part of the schema: strip-mode
    // drops them from `input`, while `raw` keeps the original keys for the
    // route's forbidden-field rejection.
    expect(result).toEqual({
      ok: true,
      input: { repoOwner: "open-inspect", repoName: "background-agents" },
      raw: legacyBody,
    });
  });

  it("rejects a malformed partial session input", async () => {
    const result = await parseCreateSessionInput(jsonRequest({ repoOwner: "open-inspect" }));

    expect(result).toEqual({ ok: false, message: "Invalid session request body" });
  });

  it("parses a repo-less session input", async () => {
    const result = await parseCreateSessionInput(
      jsonRequest({
        title: "Incident sweep",
        model: "anthropic/claude-haiku-4-5",
      })
    );

    const fields = {
      title: "Incident sweep",
      model: "anthropic/claude-haiku-4-5",
    };
    expect(result).toEqual({ ok: true, input: fields, raw: fields });
  });

  it("rejects branch without repository context", async () => {
    const result = await parseCreateSessionInput(
      jsonRequest({
        title: "Incident sweep",
        branch: "main",
      })
    );

    expect(result).toEqual({ ok: false, message: "Invalid session request body" });
  });

  it("rejects whitespace-only repository identifiers", async () => {
    const result = await parseCreateSessionInput(
      jsonRequest({
        title: "Incident sweep",
        model: "anthropic/claude-haiku-4-5",
        repoOwner: "   ",
        repoName: "\t",
      })
    );

    expect(result).toEqual({ ok: false, message: "Invalid session request body" });
  });

  it("rejects invalid JSON without throwing", async () => {
    const result = await parseCreateSessionInput(rawRequest("{"));

    expect(result).toEqual({ ok: false, message: "Invalid JSON body" });
  });

  it.each([null, [], "repo", 123, true])("rejects non-object JSON body %s", async (body) => {
    const result = await parseCreateSessionInput(jsonRequest(body));

    expect(result).toEqual({ ok: false, message: "JSON body must be an object" });
  });

  it("strips an unrecognized legacy auth provider instead of validating it", async () => {
    const result = await parseCreateSessionInput(
      jsonRequest({
        repoOwner: "open-inspect",
        repoName: "background-agents",
        authProvider: "evil",
        authUserId: "123",
      })
    );

    // authProvider is no longer schema-validated; it survives only in `raw`,
    // where the route rejects it as a forbidden identity field.
    expect(result).toEqual({
      ok: true,
      input: { repoOwner: "open-inspect", repoName: "background-agents" },
      raw: {
        repoOwner: "open-inspect",
        repoName: "background-agents",
        authProvider: "evil",
        authUserId: "123",
      },
    });
  });
});
