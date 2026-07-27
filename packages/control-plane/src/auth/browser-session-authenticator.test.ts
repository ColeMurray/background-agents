import { describe, expect, it, vi } from "vitest";
import { authenticateBrowserSession } from "./browser-session-authenticator";
import type { BrowserAuthRuntime } from "./browser-auth-runtime";

describe("authenticateBrowserSession", () => {
  it("authenticates a browser session without enumerating provider accounts", async () => {
    const listUserAccounts = vi.fn(async () => {
      throw new Error("provider accounts are not required for session authentication");
    });
    const auth = {
      api: {
        getSession: vi.fn(async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: { id: "user-1" },
        })),
        listUserAccounts,
      },
    } as unknown as BrowserAuthRuntime;
    const headers = new Headers({ Cookie: "openinspect.session_token=session.signature" });

    await expect(authenticateBrowserSession(auth, headers)).resolves.toEqual({
      userId: "user-1",
      authentication: {
        mechanism: "browser_session",
        credentialId: "session-1",
        channel: { kind: "sig1", service: "web" },
      },
    });
    expect(auth.api.getSession).toHaveBeenCalledWith({
      headers,
      query: { disableRefresh: true },
    });
    expect(listUserAccounts).not.toHaveBeenCalled();
  });

  it("returns null when Better Auth does not resolve a session", async () => {
    const auth = {
      api: {
        getSession: vi.fn(async () => null),
      },
    } as unknown as BrowserAuthRuntime;

    await expect(authenticateBrowserSession(auth, new Headers())).resolves.toBeNull();
  });

  it("rejects a session whose user does not match", async () => {
    const auth = {
      api: {
        getSession: vi.fn(async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: { id: "different-user" },
        })),
      },
    } as unknown as BrowserAuthRuntime;

    await expect(authenticateBrowserSession(auth, new Headers())).rejects.toThrow(
      "Better Auth returned a cross-user session"
    );
  });
});
