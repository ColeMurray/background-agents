import { describe, expect, it } from "vitest";
import { buildAuthenticatedUrl, buildVncUrl, getSafeExternalUrl } from "./urls";

describe("buildAuthenticatedUrl", () => {
  it("adds the token while preserving existing query parameters", () => {
    expect(buildAuthenticatedUrl("https://terminal.example.com/?theme=dark", "secret token")).toBe(
      "https://terminal.example.com/?theme=dark&token=secret+token"
    );
  });

  it("replaces an existing token", () => {
    expect(buildAuthenticatedUrl("https://terminal.example.com/?token=old", "new")).toBe(
      "https://terminal.example.com/?token=new"
    );
  });

  it("rejects missing tokens and unsafe urls", () => {
    expect(buildAuthenticatedUrl("https://terminal.example.com", undefined)).toBeNull();
    expect(buildAuthenticatedUrl("http://terminal.example.com", "secret")).toBeNull();
  });
});

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

describe("buildVncUrl", () => {
  it("keeps the password out of the HTTP request by encoding it in the fragment", () => {
    expect(buildVncUrl("https://desktop.example/prefix?quality=6", "p&a ss#word")).toBe(
      "https://desktop.example/prefix/vnc.html?quality=6&autoconnect=true&resize=scale#password=p%26a+ss%23word"
    );
  });

  it("rejects missing passwords and unsafe base URLs", () => {
    expect(buildVncUrl("https://desktop.example", null)).toBeNull();
    expect(buildVncUrl("https://desktop.example", "")).toBeNull();
    expect(buildVncUrl("javascript:alert(1)", "secret")).toBeNull();
    expect(buildVncUrl("http://desktop.example", "secret")).toBeNull();
  });

  it("strips a password query parameter from the base URL", () => {
    expect(buildVncUrl("https://desktop.example/?password=leaked", "secret")).toBe(
      "https://desktop.example/vnc.html?autoconnect=true&resize=scale#password=secret"
    );
  });
});
