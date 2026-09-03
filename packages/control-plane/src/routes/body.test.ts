import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bodyIssue, parseBody, parseJsonBody } from "./body";

const schema = z.object({
  name: z.string().min(1, { error: "must not be empty" }),
  settings: z.object({ enabled: z.boolean() }).optional(),
});

function request(body: string): Request {
  return new Request("https://test.local/things", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function rejection(result: unknown): Promise<{ status: number; body: unknown }> {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  return { status: response.status, body: await response.json() };
}

describe("parseJsonBody", () => {
  it("returns the raw value", async () => {
    await expect(parseJsonBody<unknown>(request('{"a":1}'))).resolves.toEqual({ a: 1 });
  });

  it("answers 400 when the body is not JSON", async () => {
    await expect(rejection(await parseJsonBody<unknown>(request("nope")))).resolves.toEqual({
      status: 400,
      body: { error: "Invalid JSON body" },
    });
  });
});

describe("parseBody", () => {
  it("runs async refinements instead of escaping as a 500", async () => {
    const asyncSchema = z.object({
      name: z.string().refine(async (name) => name !== "taken", { error: "name is taken" }),
    });

    await expect(parseBody(request('{"name":"free"}'), asyncSchema)).resolves.toEqual({
      name: "free",
    });
    await expect(
      rejection(await parseBody(request('{"name":"taken"}'), asyncSchema))
    ).resolves.toEqual({ status: 400, body: { error: "name: name is taken" } });
  });

  it("returns the parsed body", async () => {
    await expect(parseBody(request('{"name":"x","extra":1}'), schema)).resolves.toEqual({
      name: "x",
    });
  });

  it("answers 400 when the body is not JSON", async () => {
    await expect(rejection(await parseBody(request("{"), schema))).resolves.toEqual({
      status: 400,
      body: { error: "Invalid JSON body" },
    });
  });

  it("names the failing field when the route gives no wording", async () => {
    await expect(
      rejection(await parseBody(request('{"name":"x","settings":{"enabled":"yes"}}'), schema))
    ).resolves.toEqual({
      status: 400,
      body: { error: "settings.enabled: Invalid input: expected boolean, received string" },
    });
  });

  it("answers the route's own wording for a schema failure", async () => {
    await expect(
      rejection(await parseBody(request('{"name":""}'), schema, "Invalid thing"))
    ).resolves.toEqual({ status: 400, body: { error: "Invalid thing" } });
  });

  it("keeps the route's wording out of the not-JSON answer", async () => {
    await expect(
      rejection(await parseBody(request("nope"), schema, "Invalid thing"))
    ).resolves.toEqual({ status: 400, body: { error: "Invalid JSON body" } });
  });
});

describe("bodyIssue", () => {
  it("omits the path prefix for a top-level issue", () => {
    const failure = z.string().safeParse(1);
    expect(failure.success).toBe(false);
    if (!failure.success)
      expect(bodyIssue(failure.error)).toBe("Invalid input: expected string, received number");
  });

  it("joins a nested path with dots", () => {
    const failure = z.object({ a: z.array(z.number()) }).safeParse({ a: [1, "b"] });
    expect(failure.success).toBe(false);
    if (!failure.success)
      expect(bodyIssue(failure.error)).toBe("a.1: Invalid input: expected number, received string");
  });
});
