// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { OiSessionRefresh } from "./oi-session-refresh";

const mocks = vi.hoisted(() => ({
  status: "loading",
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: mocks.status }),
}));

let fetchSpy: ReturnType<typeof vi.fn>;

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

beforeEach(() => {
  mocks.status = "loading";
  fetchSpy = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OiSessionRefresh", () => {
  it("does not ping before the SessionProvider's own session fetch resolves", () => {
    // Mount-time sequencing: the one /api/auth/session cookie write must land
    // before the first rotation write, or the two could interleave stale over
    // fresh. Waiting for "authenticated" is what orders them.
    const { rerender } = render(<OiSessionRefresh />);
    expect(fetchSpy).not.toHaveBeenCalled();

    mocks.status = "authenticated";
    rerender(<OiSessionRefresh />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("/api/auth/oi-refresh", { method: "POST" });
  });

  it("pings again when the tab becomes visible, not while hidden", () => {
    mocks.status = "authenticated";
    render(<OiSessionRefresh />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Explicit state on both sides — the handler gates on visibilityState,
    // so the test must not lean on jsdom's default being "visible".
    setVisibilityState("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    setVisibilityState("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("stops pinging after unmount", () => {
    mocks.status = "authenticated";
    const { unmount } = render(<OiSessionRefresh />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    unmount();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
