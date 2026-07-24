// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WebSessionGate } from "./web-session-gate";

const mocks = vi.hoisted(() => ({
  status: "loading",
  signOut: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ status: mocks.status }),
  signOut: mocks.signOut,
}));

let fetchSpy: ReturnType<typeof vi.fn>;

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

beforeEach(() => {
  mocks.status = "loading";
  mocks.signOut.mockReset();
  fetchSpy = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WebSessionGate", () => {
  it("waits for the SessionProvider's own session fetch before checking", () => {
    // Mount-time sequencing: the one /api/auth/session cookie write must land
    // before the first rotation write, or the two could interleave stale over
    // fresh. Waiting for "authenticated" is what orders them.
    const { rerender } = render(<WebSessionGate />);
    expect(fetchSpy).not.toHaveBeenCalled();

    mocks.status = "authenticated";
    rerender(<WebSessionGate />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("/api/auth/oi-refresh", { method: "POST" });
  });

  it("signs out when renewal reports that the session is no longer authenticated", async () => {
    mocks.status = "authenticated";
    fetchSpy.mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 }));

    render(<WebSessionGate />);

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(1));
  });

  it("can retry sign-out when NextAuth's first sign-out request fails", async () => {
    mocks.status = "authenticated";
    fetchSpy.mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 }));
    mocks.signOut
      .mockRejectedValueOnce(new Error("sign-out request failed"))
      .mockResolvedValueOnce(undefined);

    render(<WebSessionGate />);

    expect(await screen.findByText("Authentication temporarily unavailable")).toBeTruthy();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(2));
  });

  it("holds authenticated children until web-session validity is confirmed", async () => {
    mocks.status = "authenticated";
    let resolveCheck: ((response: Response) => void) | undefined;
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveCheck = resolve;
        })
    );

    render(
      <WebSessionGate>
        <div>Protected application</div>
      </WebSessionGate>
    );

    expect(screen.queryByText("Protected application")).toBeNull();
    resolveCheck?.(new Response(null, { status: 204 }));
    expect(await screen.findByText("Protected application")).toBeTruthy();
  });

  it("offers retry without signing out when authentication is temporarily unavailable", async () => {
    mocks.status = "authenticated";
    fetchSpy
      .mockResolvedValueOnce(
        Response.json({ error: "Authentication temporarily unavailable" }, { status: 503 })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    render(
      <WebSessionGate>
        <div>Protected application</div>
      </WebSessionGate>
    );

    expect(await screen.findByText("Authentication temporarily unavailable")).toBeTruthy();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(screen.queryByText("Protected application")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Protected application")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("checks a newly authenticated session before revealing children again", async () => {
    mocks.status = "authenticated";
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { rerender } = render(
      <WebSessionGate>
        <div>Protected application</div>
      </WebSessionGate>
    );

    expect(await screen.findByText("Protected application")).toBeTruthy();

    mocks.status = "unauthenticated";
    rerender(
      <WebSessionGate>
        <div>Protected application</div>
      </WebSessionGate>
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    let resolveNewSession: ((response: Response) => void) | undefined;
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveNewSession = resolve;
        })
    );
    mocks.status = "authenticated";
    rerender(
      <WebSessionGate>
        <div>Protected application</div>
      </WebSessionGate>
    );

    expect(screen.queryByText("Protected application")).toBeNull();
    resolveNewSession?.(new Response(null, { status: 204 }));
    expect(await screen.findByText("Protected application")).toBeTruthy();
  });

  it("does not start an overlapping check when focus returns during renewal", () => {
    mocks.status = "authenticated";
    fetchSpy.mockImplementation(() => new Promise<Response>(() => undefined));
    render(<WebSessionGate />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("checks again when the tab becomes visible, not while hidden", async () => {
    mocks.status = "authenticated";
    render(
      <WebSessionGate>
        <div>Protected application</div>
      </WebSessionGate>
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Protected application")).toBeTruthy();

    // Explicit state on both sides — the handler gates on visibilityState,
    // so the test must not lean on jsdom's default being "visible".
    setVisibilityState("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    setVisibilityState("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("stops checking after unmount", () => {
    mocks.status = "authenticated";
    const { unmount } = render(<WebSessionGate />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    unmount();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
