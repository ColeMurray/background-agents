import { describe, expect, it } from "vitest";
import type { ExternalAction } from "@open-inspect/shared";
import { createProviderExecutor, type ProviderFetch, type ProviderFetchOptions } from "./executor";
import { externalActionMarker, type ExternalActionProviderDefinition } from "./definition";

/** A fault-injecting provider handler. */
export type ConformanceHandler = (
  url: string,
  init: ProviderFetchOptions
) => Response | Promise<Response>;

/**
 * The generic contract every external-action provider must satisfy.
 *
 * A provider is not registered because it looks right; it is registered
 * because it passes this suite. The suite injects faults rather than calling
 * a real provider, so it is safe to run anywhere and proves the exact
 * behaviours the ledger depends on:
 *
 * - a lost response never becomes a second publication,
 * - a refusal is a refusal, not an unknown,
 * - an unknown stays unknown so the gateway reconciles it,
 * - no credential ever reaches a result, an error, or the agent.
 */
export function describeProviderConformance(
  definition: ExternalActionProviderDefinition,
  createFetch: (handler: ConformanceHandler) => ProviderFetch
): void {
  const credential = { headers: { authorization: "Bearer secret-token-value" } };
  const action = buildAction(definition);

  const executor = (handler: ConformanceHandler) =>
    createProviderExecutor({
      definition,
      credentials: { resolve: async () => credential },
      fetch: createFetch(handler),
      timeoutMs: 50,
      userAgent: "open-inspect-conformance",
    });

  describe(`${definition.provider} ${definition.action} provider conformance`, () => {
    it("publishes once and returns a credential-free result", async () => {
      const published = executor(() =>
        Response.json({ id: 7, html_url: "https://example.test/7", body: "hello" })
      );

      const result = await published.execute(action);

      expect(result.kind).toBe("succeeded");
      expect(JSON.stringify(result)).not.toContain("secret-token-value");
    });

    it("treats a refused caller as a refusal, not as an unknown", async () => {
      const refused = executor(() =>
        Response.json({ message: "Bad credentials" }, { status: 401 })
      );

      const result = await refused.execute(action);

      expect(result.kind).toBe("rejected");
      expect(JSON.stringify(result)).not.toContain("secret-token-value");
    });

    it("treats a missing target as a refusal rather than an unknown", async () => {
      const missing = executor(() => Response.json({ message: "Not Found" }, { status: 404 }));

      const result = await missing.execute(action);

      expect(result.kind).toBe("rejected");
    });

    it("raises an indeterminate failure when the provider may still have applied the effect", async () => {
      const failing = executor(() => Response.json({ message: "Server error" }, { status: 500 }));

      await expect(failing.execute(action)).rejects.toThrow(/did not confirm/);
    });

    it("raises an indeterminate failure when the provider never answers", async () => {
      const hanging = executor(() => new Promise<Response>(() => {}));

      await expect(hanging.execute(action)).rejects.toThrow();
    });

    it("survives a malformed provider response without leaking it", async () => {
      const malformed = executor(() => new Response("not json at all", { status: 201 }));

      const result = await malformed.execute(action);

      expect(result.kind).toBe("succeeded");
      expect(JSON.stringify(result)).not.toContain("not json at all");
    });

    it("fails closed when no credential is available", async () => {
      const credentialless = createProviderExecutor({
        definition,
        credentials: { resolve: async () => null },
        fetch: createFetch(() => Response.json({ id: 1 })),
        timeoutMs: 50,
        userAgent: "open-inspect-conformance",
      });
      await expect(credentialless.execute(action)).rejects.toThrow(/no credential/);
    });

    it("finds an earlier publication by its marker instead of publishing twice", async () => {
      const marker = externalActionMarker(action.id);
      const reconciled = executor(() =>
        Response.json([
          { id: 1, body: "an older comment" },
          { id: 2, body: `published\n\n${marker}`, html_url: "https://example.test/2" },
        ])
      );

      const status = await reconciled.status(action);

      expect(status.kind).toBe("succeeded");
      expect(JSON.stringify(status)).not.toContain("secret-token-value");
    });

    it("reports a missing publication as never admitted", async () => {
      const absent = executor(() => Response.json([{ id: 1, body: "an older comment" }]));

      const status = await absent.status(action);

      expect(status.kind).toBe("not_admitted");
    });

    it("reports a missing target as never admitted while reconciling", async () => {
      const missing = executor(() => Response.json({ message: "Not Found" }, { status: 404 }));

      const status = await missing.status(action);

      expect(status.kind).toBe("not_admitted");
    });

    it("keeps an unreachable provider unknown while reconciling", async () => {
      const failing = executor(() => Response.json({ message: "Server error" }, { status: 500 }));

      const status = await failing.status(action);

      expect(status.kind).toBe("unknown");
      expect(JSON.stringify(status)).not.toContain("secret-token-value");
    });

    it("writes a marker into the published body so a lost response can be reconciled", async () => {
      let body: string | undefined;
      const capturing = createProviderExecutor({
        definition,
        credentials: { resolve: async () => credential },
        fetch: createFetch((_url, init) => {
          body = init.body;
          return Response.json({ id: 3 });
        }),
        timeoutMs: 50,
        userAgent: "open-inspect-conformance",
      });

      await capturing.execute(action);

      expect(body).toContain(externalActionMarker(action.id));
      expect(body).not.toContain("secret-token-value");
    });
  });
}

function buildAction(definition: ExternalActionProviderDefinition): ExternalAction {
  const target = targetFor(definition);
  return {
    id: "action-1",
    sessionId: "session-1",
    operationId: "operation-1",
    toolCallId: "call-1",
    idempotencyKey: "pi:operation-1:call-1",
    provider: definition.provider,
    action: definition.action,
    summary: "Publish a comment",
    target,
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
  };
}

/** A target every definition can build its endpoint from. */
function targetFor(definition: ExternalActionProviderDefinition): Record<string, string | number> {
  switch (definition.provider) {
    case "github":
      return { owner: "acme", repo: "widgets", number: 42 };
    case "gitlab":
      return { project: "acme/widgets", number: 42 };
    case "slack":
      return { channel: "C0123", thread: "1700000000.000100" };
    case "linear":
      return { issueId: "issue-1" };
    default:
      return {};
  }
}
