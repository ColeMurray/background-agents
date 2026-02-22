import { describe, expect, it } from "vitest";
import {
  MAX_MCP_CONFIG_BYTES,
  RepoMcpValidationError,
  collectSecretRefs,
  resolveMcpSecretRefs,
  validateRepoMcpConfig,
} from "./repo-mcp-config";

describe("validateRepoMcpConfig", () => {
  it("accepts valid stdio server config", () => {
    const result = validateRepoMcpConfig({
      mcpServers: {
        local: {
          transport: "stdio",
          command: "node",
          args: ["server.js"],
        },
      },
    });

    expect(result.mcpServers.local.command).toBe("node");
  });

  it("rejects missing mcpServers", () => {
    expect(() => validateRepoMcpConfig({})).toThrow(RepoMcpValidationError);
  });

  it("rejects stdio without command", () => {
    expect(() =>
      validateRepoMcpConfig({
        mcpServers: {
          local: {
            transport: "stdio",
          },
        },
      })
    ).toThrow(RepoMcpValidationError);
  });

  it("rejects http without url", () => {
    expect(() =>
      validateRepoMcpConfig({
        mcpServers: {
          remote: {
            transport: "http",
          },
        },
      })
    ).toThrow(RepoMcpValidationError);
  });

  it("rejects config larger than max bytes", () => {
    expect(() =>
      validateRepoMcpConfig({
        mcpServers: {
          huge: {
            transport: "stdio",
            command: "node",
            env: {
              BIG: "x".repeat(MAX_MCP_CONFIG_BYTES),
            },
          },
        },
      })
    ).toThrow(RepoMcpValidationError);
  });
});

describe("collectSecretRefs", () => {
  it("collects unique secret refs from env and headers", () => {
    const refs = collectSecretRefs(
      validateRepoMcpConfig({
        mcpServers: {
          a: {
            transport: "stdio",
            command: "node",
            env: {
              TOKEN: "secret:api_token",
            },
          },
          b: {
            transport: "http",
            url: "https://example.com",
            headers: {
              Authorization: "secret:api_token",
              "X-Key": "secret:SECOND_KEY",
            },
          },
        },
      })
    );

    expect(refs).toEqual(["API_TOKEN", "SECOND_KEY"]);
  });
});

describe("resolveMcpSecretRefs", () => {
  it("resolves secret placeholders and reports missing keys", () => {
    const config = validateRepoMcpConfig({
      mcpServers: {
        local: {
          transport: "stdio",
          command: "node",
          env: {
            API_KEY: "secret:OPENAI_API_KEY",
            STATIC: "value",
            MISSING: "secret:DOES_NOT_EXIST",
          },
        },
      },
    });

    const result = resolveMcpSecretRefs(config, { OPENAI_API_KEY: "secret-value" });

    expect(result.resolvedConfig.mcpServers.local.env).toEqual({
      API_KEY: "secret-value",
      STATIC: "value",
    });
    expect(result.missingSecretKeys).toEqual(["DOES_NOT_EXIST"]);
  });
});
