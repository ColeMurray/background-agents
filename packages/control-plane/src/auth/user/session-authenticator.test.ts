import { describe, expect, it, vi } from "vitest";
import { authenticateSession, type SessionReader } from "./session-authenticator";

function canonicalUserReader(existingUserId: string | null = "user-1") {
  return {
    getUserById: vi.fn(async (userId: string) =>
      userId === existingUserId ? { id: userId } : null
    ),
  };
}

describe("authenticateSession", () => {
  it("authenticates a browser session without enumerating provider accounts", async () => {
    const sessionReader: SessionReader = {
      getSession: vi.fn(async () => ({
        session: { id: "session-1", userId: "user-1" },
        user: { id: "user-1" },
      })),
    };
    const headers = new Headers({ Cookie: "openinspect.session_token=session.signature" });
    const users = canonicalUserReader();

    await expect(authenticateSession(sessionReader, users, headers)).resolves.toEqual({
      userId: "user-1",
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
    expect(users.getUserById).toHaveBeenCalledWith("user-1");
  });

  it("returns null when Better Auth does not resolve a session", async () => {
    const sessionReader: SessionReader = {
      getSession: vi.fn(async () => null),
    };

    await expect(
      authenticateSession(sessionReader, canonicalUserReader(), new Headers())
    ).resolves.toBeNull();
  });

  it("rejects a session whose user does not match", async () => {
    const sessionReader: SessionReader = {
      getSession: vi.fn(async () => ({
        session: { id: "session-1", userId: "user-1" },
        user: { id: "different-user" },
      })),
    };

    await expect(
      authenticateSession(sessionReader, canonicalUserReader(), new Headers())
    ).rejects.toThrow("Better Auth returned a cross-user session");
  });

  it("rejects a Better Auth session whose canonical user is missing", async () => {
    const sessionReader: SessionReader = {
      getSession: vi.fn(async () => ({
        session: { id: "session-1", userId: "orphan-user" },
        user: { id: "orphan-user" },
      })),
    };

    await expect(
      authenticateSession(sessionReader, canonicalUserReader(null), new Headers())
    ).rejects.toThrow("Better Auth returned a user without a canonical record");
  });
});
