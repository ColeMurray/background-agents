import { describe, expect, it } from "vitest";
import { serializeBrowserSessionCookies } from "./browser-session-cookie";

describe("serializeBrowserSessionCookies", () => {
  it("forwards only the opaque Better Auth session cookie", () => {
    expect(
      serializeBrowserSessionCookies([
        { name: "__Secure-openinspect.state", value: "state" },
        { name: "__Secure-openinspect.session_token", value: "session.signature" },
        { name: "analytics", value: "tracking" },
      ])
    ).toBe("__Secure-openinspect.session_token=session.signature");
  });

  it("supports numeric chunks without accepting lookalike cookie names", () => {
    expect(
      serializeBrowserSessionCookies([
        { name: "__Secure-openinspect.session_token.0", value: "first" },
        { name: "__Secure-openinspect.session_token.attacker", value: "ignored" },
        { name: "__Secure-openinspect.session_token.1", value: "second" },
      ])
    ).toBe(
      "__Secure-openinspect.session_token.0=first; __Secure-openinspect.session_token.1=second"
    );
  });

  it("returns null when the session cookie is absent", () => {
    expect(serializeBrowserSessionCookies([])).toBeNull();
  });

  it("rejects duplicate names and invalid values", () => {
    expect(() =>
      serializeBrowserSessionCookies([
        { name: "__Secure-openinspect.session_token", value: "first" },
        { name: "__Secure-openinspect.session_token", value: "second" },
      ])
    ).toThrow("Duplicate browser session cookie");

    expect(() =>
      serializeBrowserSessionCookies([
        { name: "__Secure-openinspect.session_token", value: "valid; injected=value" },
      ])
    ).toThrow("Invalid browser session cookie value");
  });
});
