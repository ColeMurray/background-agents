import { describe, expect, it } from "vitest";
import { getSafeExternalUrl } from "./urls";

describe("getSafeExternalUrl", () => {
  it("allows https urls", () => {
    expect(getSafeExternalUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
  });

  it("allows localhost http urls for local development", () => {
    expect(getSafeExternalUrl("http://localhost:3000/preview")).toBe(
      "http://localhost:3000/preview"
    );
    expect(getSafeExternalUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    expect(getSafeExternalUrl("http://0.0.0.0:8080")).toBe("http://0.0.0.0:8080/");
    expect(getSafeExternalUrl("http://[::1]:3000")).toBe("http://[::1]:3000/");
    expect(getSafeExternalUrl("http://dev.localhost:3000")).toBe("http://dev.localhost:3000/");
  });

  it("rejects unsupported protocols", () => {
    expect(getSafeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(getSafeExternalUrl("data:text/html,boom")).toBeNull();
    expect(getSafeExternalUrl("ftp://example.com/file.txt")).toBeNull();
  });

  it("rejects non-local http urls", () => {
    expect(getSafeExternalUrl("http://example.com/path")).toBeNull();
  });

  it("rejects invalid or empty urls", () => {
    expect(getSafeExternalUrl(undefined)).toBeNull();
    expect(getSafeExternalUrl(null)).toBeNull();
    expect(getSafeExternalUrl("")).toBeNull();
    expect(getSafeExternalUrl("not-a-url")).toBeNull();
  });
});
