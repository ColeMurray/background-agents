import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseQuery } from "./query";

const schema = z.object({
  limit: z
    .string()
    .regex(/^[1-9]\d*$/, { error: "Invalid limit" })
    .optional(),
  by: z.enum(["user", "repo"], { error: "by must be one of: user, repo" }),
});

function request(query: string): Request {
  return new Request(`https://test.local/things?${query}`);
}

async function rejection(result: unknown): Promise<{ status: number; body: unknown }> {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  return { status: response.status, body: await response.json() };
}

describe("parseQuery", () => {
  it("returns the parsed values for the keys the schema declares", () => {
    expect(parseQuery(request("by=repo&limit=5&unrelated=1"), schema)).toEqual({
      by: "repo",
      limit: "5",
    });
  });

  it("refuses a declared key given more than once before the schema runs", async () => {
    await expect(rejection(parseQuery(request("by=repo&by=user"), schema))).resolves.toEqual({
      status: 400,
      body: { error: "Invalid by" },
    });
  });

  it("ignores repeats of keys the schema does not declare", () => {
    expect(parseQuery(request("by=user&unrelated=1&unrelated=2"), schema)).toEqual({
      by: "user",
    });
  });

  it("answers the first schema issue with its own message", async () => {
    await expect(rejection(parseQuery(request("limit=0&by=nope"), schema))).resolves.toEqual({
      status: 400,
      body: { error: "Invalid limit" },
    });
    await expect(rejection(parseQuery(request("limit=1"), schema))).resolves.toEqual({
      status: 400,
      body: { error: "by must be one of: user, repo" },
    });
  });
});
