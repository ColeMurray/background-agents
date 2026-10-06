import { describe, expect, it } from "vitest";
import { MEMORY_SEARCH_LIMITS } from "@open-inspect/shared/types/memories";
import { factSearchResponse, type FactHit } from "./fact-search";

const hit = (id: string, overrides: Partial<FactHit> = {}): FactHit => ({
  id,
  revisionId: `rev_${id}`,
  partition: { type: "repository", repoId: 1 },
  scope: { type: "repository", repoOwner: "acme", repoName: "api" },
  title: "Billing",
  description: "Webhook processing",
  ...overrides,
});

describe("factSearchResponse", () => {
  it("returns at most limit results and reports the extra hit as hasMore", () => {
    const response = factSearchResponse([hit("a"), hit("b"), hit("c")], 2);
    expect(response).toEqual({
      results: [
        expect.objectContaining({
          id: "a",
          scope: { type: "repository", repoOwner: "acme", repoName: "api" },
        }),
        expect.objectContaining({ id: "b" }),
      ],
      hasMore: true,
    });
  });

  it("bounds the serialized response, counting escaping, and reports the cut as hasMore", () => {
    const hits = Array.from({ length: 20 }, (_, i) =>
      hit(`escape-${i}`, { title: "\u0001".repeat(200), description: "\u0001".repeat(420) })
    );
    const response = factSearchResponse(hits, 20);
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results.length).toBeLessThan(20);
    expect(response.hasMore).toBe(true);
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(MEMORY_SEARCH_LIMITS.response);
  });
});
