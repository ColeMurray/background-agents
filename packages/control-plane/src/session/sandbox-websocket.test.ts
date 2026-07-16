import { describe, expect, it } from "vitest";
import { getSandboxWebSocketId } from "./sandbox-websocket";

describe("getSandboxWebSocketId", () => {
  it("reads sandbox identity from the sandbox_id query parameter", () => {
    const url = new URL(
      "https://control-plane.test/sessions/session-1/ws?type=sandbox&sandbox_id=sandbox%2Fone"
    );

    expect(getSandboxWebSocketId(url)).toBe("sandbox/one");
  });

  it("returns null when sandbox_id is absent", () => {
    const url = new URL("https://control-plane.test/sessions/session-1/ws?type=sandbox");

    expect(getSandboxWebSocketId(url)).toBeNull();
  });
});
