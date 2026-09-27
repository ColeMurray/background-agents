import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TOKEN_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
];

describe("migration 0081: session token totals", () => {
  it("adds a non-null integer column per token kind defaulting to zero", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info('sessions')").all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>();

    expect(columns.results.filter((column) => TOKEN_COLUMNS.includes(column.name))).toEqual(
      TOKEN_COLUMNS.map((name) => ({
        name,
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
        cid: expect.any(Number),
        pk: 0,
      }))
    );
  });
});
