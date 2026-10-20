import { describe, expect, it } from "vitest";
import { buildExternalActionProviderRegistry } from "./registry";
import type { ProviderFetch } from "./executor";

const fetchStub: ProviderFetch = async () => Response.json({ id: 1 });

describe("external action provider registry", () => {
  it("registers no provider when the deployment supplies no credential source", () => {
    const registry = buildExternalActionProviderRegistry({
      credentials: [],
      fetch: fetchStub,
      timeoutMs: 50,
      userAgent: "open-inspect",
    });

    expect(registry.get("github", "comment")).toBeUndefined();
    expect(registry.get("slack", "reply")).toBeUndefined();
  });

  it("registers exactly the providers the deployment enables", () => {
    const registry = buildExternalActionProviderRegistry({
      credentials: [{ provider: "github", resolve: async () => null }],
      fetch: fetchStub,
      timeoutMs: 50,
      userAgent: "open-inspect",
    });

    expect(registry.get("github", "comment")).toBeDefined();
    expect(registry.get("gitlab", "comment")).toBeUndefined();
    expect(registry.get("slack", "reply")).toBeUndefined();
  });

  it("refuses a provider that has no definition", () => {
    expect(() =>
      buildExternalActionProviderRegistry(
        {
          credentials: [
            { provider: "github", resolve: async () => null },
            { provider: "linear", resolve: async () => null },
          ],
          fetch: fetchStub,
          timeoutMs: 50,
          userAgent: "open-inspect",
        },
        []
      )
    ).toThrow(/No external action definition/);
  });
});
