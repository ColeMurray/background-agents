import { describe, expect, it, vi } from "vitest";
import { authenticateSession, type SessionReader } from "./session-authenticator";

describe("authenticateSession", () => {
  it("authenticates a browser session without enumerating provider accounts", async () => {
    const userId = "0123456789abcdef0123456789abcdef";
    const sessionReader: SessionReader = {
      getSession: vi.fn(async () => ({
        session: { id: "session-1", userId },
        user: { id: userId },
      })),
    };
    const headers = new Headers({ Cookie: "openinspect.session_token=session.signature" });

    await expect(authenticateSession(sessionReader, headers)).resolves.toEqual({
      userId,
      authentication: {
        mechanism: "browser_session",
        credentialId: "session-1",
        channel: { kind: "sig1", service: "web" },
      },
    });
    expect(sessionReader.getSession).toHaveBeenCalledWith({
      headers,
      query: { disableRefresh: true },
    });
  });

  it("returns null when Better Auth does not resolve a session", async () => {
    const sessionReader: SessionReader = {
      getSession: vi.fn(async () => null),
    };

    await expect(authenticateSession(sessionReader, new Headers())).resolves.toBeNull();
  });

  it("rejects a session whose user does not match", async () => {
    const sessionReader: SessionReader = {
      getSession: vi.fn(async () => ({
        session: { id: "session-1", userId: "0123456789abcdef0123456789abcdef" },
        user: { id: "11111111111111111111111111111111" },
      })),
    };

    await expect(authenticateSession(sessionReader, new Headers())).rejects.toThrow(
      "Better Auth returned a cross-user session"
    );
  });

  it("rejects a non-canonical user principal", async () => {
    const sessionReader: SessionReader = {
      getSession: vi.fn(async () => ({
        session: { id: "session-1", userId: "legacy-user" },
        user: { id: "legacy-user" },
      })),
    };

    await expect(authenticateSession(sessionReader, new Headers())).rejects.toThrow(
      "Better Auth returned a malformed session"
    );
  });
});
