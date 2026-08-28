import { describe, expect, it, vi } from "vitest";
import { createLatchedPublicSessionIdResolver, resolvePublicSessionId } from "./public-session-id";
import type { SessionRow } from "./types";

function sessionRow(overrides: Partial<SessionRow>): SessionRow {
  return { id: "row-id", session_name: null, ...overrides } as SessionRow;
}

describe("resolvePublicSessionId", () => {
  it("prefers the session name", () => {
    expect(
      resolvePublicSessionId(sessionRow({ session_name: "my-session", id: "row-id" }), "do-id")
    ).toBe("my-session");
  });

  it("falls back to the row id when the session has no name", () => {
    expect(resolvePublicSessionId(sessionRow({ session_name: null, id: "row-id" }), "do-id")).toBe(
      "row-id"
    );
  });

  it("treats an empty session name as absent", () => {
    expect(resolvePublicSessionId(sessionRow({ session_name: "", id: "row-id" }), "do-id")).toBe(
      "row-id"
    );
  });

  it("falls back to the durable object id when there is no session row", () => {
    expect(resolvePublicSessionId(null, "do-id")).toBe("do-id");
    expect(resolvePublicSessionId(undefined, "do-id")).toBe("do-id");
  });

  it("falls back to the durable object id when the row carries neither identifier", () => {
    expect(resolvePublicSessionId(sessionRow({ session_name: "", id: "" }), "do-id")).toBe("do-id");
  });
});

describe("createLatchedPublicSessionIdResolver", () => {
  it("re-reads on every call while no session row exists", () => {
    const getSession = vi.fn((): SessionRow | null => null);
    const resolve = createLatchedPublicSessionIdResolver(getSession, "do-id");

    expect(resolve()).toBe("do-id");
    expect(resolve()).toBe("do-id");
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("upgrades to the public id once the row appears, then stops reading", () => {
    let row: SessionRow | null = null;
    const getSession = vi.fn(() => row);
    const resolve = createLatchedPublicSessionIdResolver(getSession, "do-id");

    expect(resolve()).toBe("do-id");
    row = sessionRow({ session_name: "public-name" });
    expect(resolve()).toBe("public-name");

    // Latched: the id is immutable once row-backed, so no further reads.
    row = sessionRow({ session_name: "some-other-name" });
    expect(resolve()).toBe("public-name");
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("never latches the durable-object-id fallback", () => {
    const getSession = vi.fn((): SessionRow | null => null);
    const resolve = createLatchedPublicSessionIdResolver(getSession, "do-id");
    resolve();
    resolve();
    resolve();
    expect(getSession).toHaveBeenCalledTimes(3);
  });
});
