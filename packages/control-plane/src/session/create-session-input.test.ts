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
  it("parses a valid githubReview fence object", async () => {
    const fields = {
      repoOwner: "open-inspect",
      repoName: "background-agents",
      githubReview: {
        repoId: 123,
        prNumber: 45,
        generation: 2,
        headSha: "abc123",
      },
    };
    const result = await parseCreateSessionInput(jsonRequest(fields));

    expect(result).toEqual({ ok: true, input: fields, raw: fields });
  });

  it("rejects a githubReview object missing a required field", async () => {
    const result = await parseCreateSessionInput(
      jsonRequest({
        repoOwner: "open-inspect",
        repoName: "background-agents",
        githubReview: { repoId: 123, prNumber: 45, generation: 2 },
      })
    );

    expect(result).toEqual({ ok: false, message: "Invalid session request body" });
  });

  it("rejects a githubReview object with a non-positive generation", async () => {
    const result = await parseCreateSessionInput(
      jsonRequest({
        repoOwner: "open-inspect",
        repoName: "background-agents",
        githubReview: { repoId: 123, prNumber: 45, generation: 0, headSha: "abc123" },
      })
    );

    expect(result).toEqual({ ok: false, message: "Invalid session request body" });
  });

  it.each([
    ["owner", { owner: "   ", repo: "background-agents" }],
    ["repo", { owner: "open-inspect", repo: " " }],
  ])("rejects a githubReview whose %s is blank", async (_field, repository) => {
    // F10: a blank repository would be stored on the fence row and close out nothing.
    const result = await parseCreateSessionInput(
      jsonRequest({
        repoOwner: "open-inspect",
        repoName: "background-agents",
        githubReview: {
          repoId: 123,
          prNumber: 45,
          generation: 2,
          headSha: "abc123",
          ...repository,
        },
      })
    );

    expect(result).toEqual({ ok: false, message: "Invalid session request body" });
  });
});
