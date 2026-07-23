import { describe, expect, it } from "vitest";
import { parseTunnelUrls } from "./tunnel-urls";

describe("parseTunnelUrls", () => {
  it("parses a port -> url map", () => {
    const raw = JSON.stringify({ "3000": "https://a.example", "5000": "https://b.example" });
    expect(parseTunnelUrls(raw)).toEqual({
      "3000": "https://a.example",
      "5000": "https://b.example",
    });
  });

  it("returns an empty map for an empty object", () => {
    expect(parseTunnelUrls("{}")).toEqual({});
  });

  it("returns null for invalid JSON", () => {
    expect(parseTunnelUrls("{not json")).toBeNull();
  });

  it("returns null when the value is not an object", () => {
    expect(parseTunnelUrls(JSON.stringify(["3000", "5000"]))).toBeNull();
    expect(parseTunnelUrls(JSON.stringify("3000"))).toBeNull();
    expect(parseTunnelUrls(JSON.stringify(42))).toBeNull();
    expect(parseTunnelUrls(JSON.stringify(null))).toBeNull();
  });

  it("returns null when any value is not a string", () => {
    expect(parseTunnelUrls(JSON.stringify({ "3000": 5000 }))).toBeNull();
    expect(
      parseTunnelUrls(JSON.stringify({ "3000": "https://a.example", "5000": null }))
    ).toBeNull();
    expect(parseTunnelUrls(JSON.stringify({ "3000": { nested: true } }))).toBeNull();
  });
});
