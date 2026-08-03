// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionTabs,
  SessionTabsProvider,
  type SessionTabInput,
  useSessionTabs,
} from "./session-tabs";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  pathname: "/session/first",
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/hooks/use-session-target-picker", () => ({
  useSessionTargetPicker: () => ({}),
}));

const sessions: SessionTabInput[] = [
  { id: "first", title: "Fix authentication", repoOwner: "open", repoName: "inspect" },
  { id: "second", title: "Improve dashboard", repoOwner: "open", repoName: "inspect" },
];

function RegisterSessions() {
  const { registerSession } = useSessionTabs();

  useEffect(() => {
    sessions.forEach(registerSession);
  }, [registerSession]);

  return null;
}

function RegisterManySessions() {
  const { registerSession } = useSessionTabs();

  useEffect(() => {
    for (let index = 1; index <= 11; index += 1) {
      registerSession({ id: `bulk-${index}`, title: `Bulk ${index}` });
    }
  }, [registerSession]);

  return null;
}

function CompleteNewSession() {
  const { completeNewSession } = useSessionTabs();
  return (
    <button type="button" onClick={() => completeNewSession("third")}>
      Complete session
    </button>
  );
}

function TabTestActions() {
  const { closeSession, registerSession } = useSessionTabs();
  return (
    <>
      <button type="button" onClick={() => closeSession("first")}>
        Close first programmatically
      </button>
      <button type="button" onClick={() => closeSession("second")}>
        Close second programmatically
      </button>
      <button
        type="button"
        onClick={() =>
          registerSession({ id: "third", title: "Loading session...", isLoading: true })
        }
      >
        Register loading session
      </button>
    </>
  );
}

function renderTabs() {
  return render(
    <SessionTabsProvider>
      <RegisterSessions />
      <SessionTabs />
    </SessionTabsProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.pathname = "/session/first";
});

describe("SessionTabs", () => {
  it("switches between registered sessions and preserves route metadata", async () => {
    renderTabs();

    fireEvent.click(await screen.findByRole("tab", { name: "Open Improve dashboard" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/session/second?repoOwner=open&repoName=inspect&title=Improve+dashboard"
    );
  });

  it("supports arrow-key navigation with a single tab stop", async () => {
    renderTabs();

    const firstTab = await screen.findByRole("tab", { name: "Open Fix authentication" });
    const secondTab = screen.getByRole("tab", { name: "Open Improve dashboard" });
    expect(firstTab).toHaveAttribute("tabindex", "0");
    expect(secondTab).toHaveAttribute("tabindex", "-1");

    firstTab.focus();
    fireEvent.keyDown(firstTab, { key: "ArrowRight" });

    expect(secondTab).toHaveFocus();
    expect(mocks.push).toHaveBeenCalledWith(
      "/session/second?repoOwner=open&repoName=inspect&title=Improve+dashboard"
    );
  });

  it("scopes arrow-key focus to the session tablist", async () => {
    render(
      <>
        <button role="tab">Unrelated tab</button>
        <SessionTabsProvider>
          <RegisterSessions />
          <SessionTabs />
        </SessionTabsProvider>
      </>
    );

    const firstTab = await screen.findByRole("tab", { name: "Open Fix authentication" });
    const secondTab = screen.getByRole("tab", { name: "Open Improve dashboard" });
    firstTab.focus();
    fireEvent.keyDown(firstTab, { key: "ArrowRight" });

    expect(secondTab).toHaveFocus();
  });

  it("uses the current route when an async caller closes an old session", async () => {
    const view = render(
      <SessionTabsProvider>
        <RegisterSessions />
        <TabTestActions />
        <SessionTabs />
      </SessionTabsProvider>
    );
    await screen.findByRole("tab", { name: "Open Fix authentication" });

    mocks.pathname = "/session/second";
    view.rerender(
      <SessionTabsProvider>
        <RegisterSessions />
        <TabTestActions />
        <SessionTabs />
      </SessionTabsProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Close first programmatically" }));

    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "Open Fix authentication" })).not.toBeInTheDocument();
  });

  it("honors tab navigation before the pathname update commits", async () => {
    render(
      <SessionTabsProvider>
        <RegisterSessions />
        <TabTestActions />
        <SessionTabs />
      </SessionTabsProvider>
    );

    fireEvent.click(await screen.findByRole("tab", { name: "Open Improve dashboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Close first programmatically" }));

    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith(
      "/session/second?repoOwner=open&repoName=inspect&title=Improve+dashboard"
    );
  });

  it("evicts the oldest inactive session when the tab limit is exceeded", async () => {
    mocks.pathname = "/session/bulk-1";
    render(
      <SessionTabsProvider>
        <RegisterManySessions />
        <SessionTabs />
      </SessionTabsProvider>
    );

    expect(await screen.findByRole("tab", { name: "Open Bulk 1" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Open Bulk 2" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Open Bulk 11" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(10);
  });

  it("closes an inactive tab without navigating", async () => {
    renderTabs();

    fireEvent.click(await screen.findByRole("button", { name: "Close Improve dashboard" }));

    expect(screen.queryByRole("tab", { name: "Open Improve dashboard" })).not.toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("selects an adjacent session when the active tab closes", async () => {
    renderTabs();

    fireEvent.click(await screen.findByRole("button", { name: "Close Fix authentication" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/session/second?repoOwner=open&repoName=inspect&title=Improve+dashboard"
    );
  });

  it("updates the intended active tab before route navigation commits", async () => {
    render(
      <SessionTabsProvider>
        <RegisterSessions />
        <TabTestActions />
        <SessionTabs />
      </SessionTabsProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Close Fix authentication" }));
    fireEvent.click(screen.getByRole("button", { name: "Close second programmatically" }));

    expect(mocks.push).toHaveBeenNthCalledWith(
      1,
      "/session/second?repoOwner=open&repoName=inspect&title=Improve+dashboard"
    );
    expect(mocks.push).toHaveBeenNthCalledWith(2, "/");
  });

  it("opens the new-session page from the plus button", async () => {
    const view = renderTabs();

    fireEvent.click(await screen.findByRole("button", { name: "New session" }));

    expect(mocks.push).toHaveBeenCalledWith("/");
    expect(screen.getByRole("tab", { name: "Open New session" })).toBeInTheDocument();
    mocks.pathname = "/";
    view.rerender(
      <SessionTabsProvider>
        <RegisterSessions />
        <SessionTabs />
      </SessionTabsProvider>
    );
    expect(await screen.findByRole("tab", { name: "Open New session" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Open Fix authentication" })).toBeInTheDocument();
  });

  it("renders the new-session page as a tab without hiding existing sessions", async () => {
    mocks.pathname = "/";
    renderTabs();

    expect(await screen.findByRole("tab", { name: "Open New session" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Open Fix authentication" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Open Improve dashboard" })).toBeInTheDocument();
  });

  it("replaces the draft tab when session creation completes", async () => {
    mocks.pathname = "/";
    render(
      <SessionTabsProvider>
        <RegisterSessions />
        <CompleteNewSession />
        <SessionTabs />
      </SessionTabsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Complete session" }));

    expect(screen.queryByRole("tab", { name: "Open New session" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Open Starting session..." })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("keeps the pending title until session metadata loads", () => {
    mocks.pathname = "/";
    const view = render(
      <SessionTabsProvider>
        <CompleteNewSession />
        <TabTestActions />
        <SessionTabs />
      </SessionTabsProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Complete session" }));

    mocks.pathname = "/session/third";
    view.rerender(
      <SessionTabsProvider>
        <CompleteNewSession />
        <TabTestActions />
        <SessionTabs />
      </SessionTabsProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Register loading session" }));

    expect(screen.getByRole("tab", { name: "Open Starting session..." })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Open Loading session..." })).not.toBeInTheDocument();
  });

  it("opens a separate draft while another session is pending", () => {
    mocks.pathname = "/";
    render(
      <SessionTabsProvider>
        <CompleteNewSession />
        <SessionTabs />
      </SessionTabsProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Complete session" }));

    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    expect(screen.getByRole("tab", { name: "Open Starting session..." })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Open New session" })).toBeInTheDocument();
  });

  it("returns to an adjacent session when the active draft closes", async () => {
    mocks.pathname = "/";
    renderTabs();

    fireEvent.click(await screen.findByRole("button", { name: "Close New session" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/session/first?repoOwner=open&repoName=inspect&title=Fix+authentication"
    );
  });

  it("keeps the final new-session tab open", () => {
    mocks.pathname = "/";
    render(
      <SessionTabsProvider>
        <SessionTabs />
      </SessionTabsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Close New session" }));

    expect(screen.getByRole("tab", { name: "Open New session" })).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
