import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("migration 0076: external session request fingerprint", () => {
  it("adds a nullable canonical request fingerprint to sessions", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(sessions)").all<{
      name: string;
      notnull: number;
    }>();
    expect(columns.results).toContainEqual(
      expect.objectContaining({ name: "external_request_fingerprint", notnull: 0 })
    );
  });
});
