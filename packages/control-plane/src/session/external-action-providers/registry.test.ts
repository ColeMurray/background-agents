import { describe, expect, it, vi } from "vitest";
import { buildExternalActionProviderRegistry } from "./registry";
import type { ExternalActionCredentialResolver } from "../external-action-credentials";

function resolver(
  available: readonly string[] = []
): ExternalActionCredentialResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    available: async (provider: string) => available.includes(provider),
    resolve: async (provider: string) => {
      calls.push(provider);
      return available.includes(provider) ? { headers: { authorization: "Bearer test" } } : null;
    },
  };
}

describe("external action provider registry", () => {
  it("registers nothing when the deployment named no provider", () => {
    const registry = buildExternalActionProviderRegistry({
      credentials: resolver(),
      fetch: async () => Response.json({}),
      timeoutMs: 50,
      userAgent: "open-inspect",
      enabledProviders: [],
    });

    expect(registry.get("github", "comment")).toBeUndefined();
    expect(registry.get("slack", "reply")).toBeUndefined();
  });

  it("registers only the providers the deployment named", () => {
    const registry = buildExternalActionProviderRegistry({
      credentials: resolver(),
      fetch: async () => Response.json({}),
      timeoutMs: 50,
      userAgent: "open-inspect",
      enabledProviders: ["github", "slack"],
    });

    expect(registry.get("github", "comment")).toBeDefined();
    expect(registry.get("slack", "reply")).toBeDefined();
    expect(registry.get("gitlab", "comment")).toBeUndefined();
    expect(registry.get("linear", "comment")).toBeUndefined();
  });

  it("resolves the credential per call rather than capturing it", async () => {
    const credentials = resolver(["github"]);
    const registry = buildExternalActionProviderRegistry({
      credentials,
      fetch: async () => Response.json({}),
      timeoutMs: 50,
      userAgent: "open-inspect",
      enabledProviders: ["github"],
    });
    const definition = registry.get("github", "comment");
    expect(definition).toBeDefined();
    expect(credentials.calls).toEqual([]);
  });

  it("refuses a provider that has no definition", () => {
    expect(() =>
      buildExternalActionProviderRegistry({
        credentials: resolver(),
        fetch: async () => Response.json({}),
        timeoutMs: 50,
        userAgent: "open-inspect",
        enabledProviders: ["github"],
      })
    ).not.toThrow();
  });

  it("executes a provider call with the resolved credential", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ id: 7, html_url: "https://example.test/7" })
    );
    const registry = buildExternalActionProviderRegistry({
      credentials: resolver(["github"]),
      fetch: fetchMock as never,
      timeoutMs: 50,
      userAgent: "open-inspect",
      enabledProviders: ["github"],
    });
    const definition = registry.get("github", "comment")!;

    const result = await definition.executor.execute({
      id: "action-1",
      sessionId: "session-1",
      operationId: "operation-1",
      toolCallId: "call-1",
      idempotencyKey: "key-1",
      provider: "github",
      action: "comment",
      summary: "Comment",
      target: { owner: "acme", repo: "widgets", number: 42 },
      arguments: { body: "hello" },
      fingerprint: "sha256:test",
      state: "approved",
      approval: null,
      providerReference: null,
      publicResult: null,
      error: null,
      revision: 2,
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: null,
    });

    expect(result.kind).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledOnce();
    const captured = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(captured[1].headers.authorization).toBe("Bearer test");
  });
});
