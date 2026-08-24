import { describe, expect, it } from "vitest";
import { resolvePublicSessionId } from "./public-session-id";
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
