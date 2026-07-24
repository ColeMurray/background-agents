// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WebSessionSupervisor } from "./web-session-supervisor";

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

describe("WebSessionSupervisor", () => {
  it("does not ping before the SessionProvider's own session fetch resolves", () => {
    // Mount-time sequencing: the one /api/auth/session cookie write must land
    // before the first rotation write, or the two could interleave stale over
    // fresh. Waiting for "authenticated" is what orders them.
    const { rerender } = render(<WebSessionSupervisor />);
    expect(fetchSpy).not.toHaveBeenCalled();

    mocks.status = "authenticated";
    rerender(<WebSessionSupervisor />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("/api/auth/oi-refresh", { method: "POST" });
  });

  it("signs out when renewal reports that the session is no longer authenticated", async () => {
    mocks.status = "authenticated";
    fetchSpy.mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 }));

    render(<WebSessionSupervisor />);

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(1));
  });

  it("can retry sign-out when NextAuth's first sign-out request fails", async () => {
    mocks.status = "authenticated";
    fetchSpy.mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 }));
    mocks.signOut
      .mockRejectedValueOnce(new Error("sign-out request failed"))
      .mockResolvedValueOnce(undefined);

    render(<WebSessionSupervisor />);

    expect(await screen.findByText("Authentication temporarily unavailable")).toBeTruthy();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(2));
  });

  it("holds authenticated children until web-session validity is confirmed", async () => {
    mocks.status = "authenticated";
    let resolvePing: ((response: Response) => void) | undefined;
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvePing = resolve;
        })
    );

    render(
      <WebSessionSupervisor>
        <div>Protected application</div>
      </WebSessionSupervisor>
    );

    expect(screen.queryByText("Protected application")).toBeNull();
    resolvePing?.(new Response(null, { status: 204 }));
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
      <WebSessionSupervisor>
        <div>Protected application</div>
      </WebSessionSupervisor>
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
      <WebSessionSupervisor>
        <div>Protected application</div>
      </WebSessionSupervisor>
    );

    expect(await screen.findByText("Protected application")).toBeTruthy();

    mocks.status = "unauthenticated";
    rerender(
      <WebSessionSupervisor>
        <div>Protected application</div>
      </WebSessionSupervisor>
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
      <WebSessionSupervisor>
        <div>Protected application</div>
      </WebSessionSupervisor>
    );

    expect(screen.queryByText("Protected application")).toBeNull();
    resolveNewSession?.(new Response(null, { status: 204 }));
    expect(await screen.findByText("Protected application")).toBeTruthy();
  });

  it("does not start an overlapping ping when focus returns during renewal", () => {
    mocks.status = "authenticated";
    fetchSpy.mockImplementation(() => new Promise<Response>(() => undefined));
    render(<WebSessionSupervisor />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("pings again when the tab becomes visible, not while hidden", async () => {
    mocks.status = "authenticated";
    render(
      <WebSessionSupervisor>
        <div>Protected application</div>
      </WebSessionSupervisor>
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

  it("stops pinging after unmount", () => {
    mocks.status = "authenticated";
    const { unmount } = render(<WebSessionSupervisor />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    unmount();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
