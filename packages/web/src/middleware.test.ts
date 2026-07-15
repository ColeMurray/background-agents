import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

describe("API middleware correlation", () => {
  it("preserves a valid incoming trace id and generates a fresh request id", () => {
    const response = middleware(
      new NextRequest("http://localhost/api/sessions", {
        headers: {
          "x-trace-id": "trace-123",
          "x-request-id": "client-request-id",
        },
      })
    );

    expect(response.headers.get("x-trace-id")).toBe("trace-123");
    expect(response.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(response.headers.get("x-request-id")).not.toBe("client-request-id");
  });

  it("generates correlation headers when the incoming trace id is invalid", () => {
    const response = middleware(
      new NextRequest("http://localhost/api/sessions", {
        headers: {
          "x-trace-id": "invalid trace id",
        },
      })
    );

    expect(response.headers.get("x-trace-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(response.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9]{8}$/);
  });
});
