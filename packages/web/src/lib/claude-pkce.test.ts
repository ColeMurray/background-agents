import { describe, expect, it } from "vitest";
import {
  CLAUDE_AUTHORIZE_URL,
  CLAUDE_CLIENT_ID,
  CLAUDE_REDIRECT_URI,
  CLAUDE_SCOPES,
  base64UrlEncode,
  buildClaudeAuthorizationUrl,
  deriveS256Challenge,
  parseClaudeAuthorizationResponse,
  randomBase64Url,
} from "./claude-pkce";

describe("Claude PKCE", () => {
  it("encodes random bytes as unpadded base64url", () => {
    expect(base64UrlEncode(new Uint8Array([251, 255, 239]))).toBe("-__v");
    expect(randomBase64Url(3, (bytes) => bytes.fill(255))).toBe("____");
  });

  it("derives an S256 challenge", async () => {
    expect(
      await deriveS256Challenge("verifier", async () => new Uint8Array([251, 255, 239]).buffer)
    ).toBe("-__v");
  });

  it("builds the observed Claude authorization URL", () => {
    const url = new URL(buildClaudeAuthorizationUrl("challenge", "expected-state"));
    expect(url.origin + url.pathname).toBe(CLAUDE_AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLAUDE_CLIENT_ID,
      response_type: "code",
      redirect_uri: CLAUDE_REDIRECT_URI,
      scope: CLAUDE_SCOPES,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "expected-state",
      code: "true",
    });
  });

  it.each([
    ["auth-code#returned-state", { authorizationCode: "auth-code", state: "returned-state" }],
    [
      "https://platform.claude.com/oauth/code/callback?code=query-code&state=query-state",
      { authorizationCode: "query-code", state: "query-state" },
    ],
    [
      "https://platform.claude.com/oauth/code/callback#code=fragment-code&state=fragment-state",
      { authorizationCode: "fragment-code", state: "fragment-state" },
    ],
    [
      "https://platform.claude.com/oauth/code/callback?code=mixed-code#state=mixed-state",
      { authorizationCode: "mixed-code", state: "mixed-state" },
    ],
  ])("parses %s", (input, expected) => {
    expect(parseClaudeAuthorizationResponse(input)).toEqual(expected);
  });

  it("requires both code and state", () => {
    expect(() => parseClaudeAuthorizationResponse("code-only")).toThrow("missing a code");
    expect(() =>
      parseClaudeAuthorizationResponse(
        "https://platform.claude.com/oauth/code/callback?code=without-state"
      )
    ).toThrow("missing state");
  });
});
