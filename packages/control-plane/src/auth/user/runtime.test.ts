import { describe, expect, it } from "vitest";
import { parsePublicWebOrigin } from "./runtime";

describe("parsePublicWebOrigin", () => {
  it.each([
    ["https://open-inspect.example", "https://open-inspect.example"],
    ["https://open-inspect.example/", "https://open-inspect.example"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
  ])("accepts a browser-reachable web origin: %s", (configured, expected) => {
    expect(parsePublicWebOrigin(configured)).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "not-a-url",
    "http://open-inspect.example",
    "http://localhost.evil.example:3000",
    "https://open-inspect.example/path",
    "https://open-inspect.example?query=1",
  ])("rejects an unsafe or non-origin WEB_APP_URL: %s", (configured) => {
    expect(() => parsePublicWebOrigin(configured)).toThrow();
  });
});
