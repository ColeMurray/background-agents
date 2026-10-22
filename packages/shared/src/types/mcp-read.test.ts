import { describe, expect, it } from "vitest";
import { mcpReadResultSchema } from "./overlay-mcp-read";
import { findCredentialLikeKeys } from "./credential-shaped";

describe("the MCP read result", () => {
  it("accepts a provider answer that carries no credential", () => {
    const parsed = mcpReadResultSchema.safeParse({
      serverId: "mcpsrv_1",
      toolName: "search_issues",
      content: { items: [{ title: "A bug" }] },
      truncated: false,
    });

    expect(parsed.success).toBe(true);
  });

  it("refuses a provider answer that carries a credential-shaped key", () => {
    const parsed = mcpReadResultSchema.safeParse({
      serverId: "mcpsrv_1",
      toolName: "whoami",
      content: { accessToken: "gho_secret" },
      truncated: false,
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a credential nested inside the provider answer", () => {
    const parsed = mcpReadResultSchema.safeParse({
      serverId: "mcpsrv_1",
      toolName: "whoami",
      content: { account: { credentials: { refresh_token: "secret" } } },
      truncated: false,
    });

    expect(parsed.success).toBe(false);
  });
});

describe("the credential-shaped guard", () => {
  it("finds a credential at any depth", () => {
    const found = findCredentialLikeKeys({
      a: [{ b: { accessToken: "x" } }],
    });

    expect(found).toHaveLength(1);
    expect(found[0]?.key).toBe("accessToken");
  });

  it("ignores a value that merely mentions a credential", () => {
    const found = findCredentialLikeKeys({
      note: "the accessToken was rotated",
      count: 3,
    });

    expect(found).toEqual([]);
  });
});
