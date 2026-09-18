import { describe, expect, it } from "vitest";
import { parseStoredCredentialPayload } from "./provider-runtime-credentials";

describe("parseStoredCredentialPayload", () => {
  it("parses a valid stored provider credential", () => {
    expect(parseStoredCredentialPayload({ token: "setup-token", expiresAt: 123 })).toEqual({
      token: "setup-token",
      expiresAt: 123,
    });
  });

  it("rejects malformed credential payloads", () => {
    expect(parseStoredCredentialPayload("setup-token")).toBeNull();
    expect(parseStoredCredentialPayload({ token: "", expiresAt: 123 })).toBeNull();
  });

  it("rejects partial credential payloads", () => {
    expect(parseStoredCredentialPayload({ token: "setup-token" })).toBeNull();
    expect(parseStoredCredentialPayload({ expiresAt: 123 })).toBeNull();
  });
});
