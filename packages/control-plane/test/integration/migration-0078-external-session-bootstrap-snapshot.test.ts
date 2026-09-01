import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("migration 0078: external session bootstrap snapshot", () => {
  it("adds a nullable resolved bootstrap snapshot to sessions", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(sessions)").all<{
      name: string;
      notnull: number;
    }>();
    expect(columns.results).toContainEqual(
      expect.objectContaining({ name: "external_bootstrap_snapshot", notnull: 0 })
    );
  });
});
