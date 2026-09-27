import { describe, expect, it } from "vitest";
import { formatHttpStatus } from "./http-status";

describe("formatHttpStatus", () => {
  it.each([
    [200, "HTTP 200 OK"],
    [201, "HTTP 201 Created"],
    [400, "HTTP 400 Bad Request"],
    [403, "HTTP 403 Forbidden"],
    [409, "HTTP 409 Conflict"],
    [500, "HTTP 500 Internal Server Error"],
    [418, "HTTP 418"],
  ])("formats %i as %s", (status, text) => {
    expect(formatHttpStatus(status)).toBe(text);
  });
});
