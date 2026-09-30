// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { SessionState } from "@open-inspect/shared/types/server-messages";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { SessionDetailsOverlay } from "./session-details-overlay";
import { SessionRightSidebar } from "./session-right-sidebar";
import { resolveSessionCapabilities, type SessionCapabilities } from "@/lib/session-capabilities";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("swr", () => ({
  default: () => ({ data: undefined }),
  useSWRConfig: () => ({ fetcher: undefined }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(browserApiFetch).mockReset();
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => "blob:session-trace"),
      revokeObjectURL: vi.fn(),
    })
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const FULL_CAPABILITIES: SessionCapabilities = {
  read: true,
  collaborate: true,
  lifecycle: true,
  sandboxAccess: true,
  exportTrace: true,
};

describe("SessionRightSidebar", () => {
  const sessionState: SessionState = {
    id: "session-1",
    title: null,
    repoOwner: null,
    repoName: null,
    baseBranch: null,
    branchName: null,
    status: "active",
    sandboxStatus: "ready",
    harness: "opencode",
    messageCount: 0,
    createdAt: 1,
    totalCost: 3,
    maxSessionCostUsd: 10,
  };

  it("hides Download trace from viewers and offers it to exporters in desktop and mobile details", () => {
    const props = {
      sessionId: "session-1",
      sessionState,
      participants: [],
      presenceSynced: false,
      events: [],
      artifacts: [],
      onOpenMedia: vi.fn(),
      capabilities: FULL_CAPABILITIES,
    };
    const { rerender } = render(
      <SessionRightSidebar {...props} capabilities={{ ...FULL_CAPABILITIES, exportTrace: false }} />
    );
    expect(screen.queryByRole("button", { name: "Download trace" })).not.toBeInTheDocument();

    rerender(<SessionRightSidebar {...props} />);
    expect(screen.getByRole("button", { name: "Download trace" })).toBeInTheDocument();

    rerender(<SessionDetailsOverlay {...props} open isPhone onOpenChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Download trace" })).toBeInTheDocument();
  });

  it("shows the denial reason when an allowed trace export receives 403", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ error: "Forbidden", reason_code: "session_read_only" }, { status: 403 })
    );
    render(
      <SessionRightSidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={resolveSessionCapabilities({ canRead: true }, true)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Download trace" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed to download trace (session_read_only)")
    );
    expect(browserApiFetch).toHaveBeenCalledWith("/api/sessions/session-1/export", {
      signal: expect.any(AbortSignal),
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("downloads a successful trace with the session filename", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      new Response('{"type":"session"}\n', { headers: { "Content-Type": "application/x-ndjson" } })
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <SessionRightSidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Download trace" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(click.mock.instances[0]).toHaveProperty("download", "session-session-1.ndjson");
    expect(click.mock.instances[0]).toHaveProperty("href", "blob:session-trace");
  });

  it.each(["session_error", "error"])(
    "reports a %s export record as a failed download",
    async (type) => {
      vi.mocked(browserApiFetch).mockResolvedValueOnce(
        new Response(`{"schemaVersion":1,"type":"${type}"}\n`, {
          headers: { "Content-Type": "application/x-ndjson" },
        })
      );
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      render(
        <SessionRightSidebar
          sessionId="session-1"
          sessionState={sessionState}
          participants={[]}
          presenceSynced={false}
          events={[]}
          artifacts={[]}
          onOpenMedia={vi.fn()}
          capabilities={FULL_CAPABILITIES}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Download trace" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to download trace"));
      expect(click).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    }
  );

  it("aborts a trace body that stalls after headers and re-enables the download button", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    vi.mocked(browserApiFetch).mockImplementationOnce(async (_path, init) => {
      fetchSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            fetchSignal?.addEventListener("abort", () => controller.error(fetchSignal?.reason), {
              once: true,
            });
          },
        }),
        { headers: { "Content-Type": "application/x-ndjson" } }
      );
    });
    render(
      <SessionRightSidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Download trace" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchSignal?.aborted).toBe(true);
    expect(toast.error).toHaveBeenCalledWith("Failed to download trace");
    expect(screen.getByRole("button", { name: "Download trace" })).not.toBeDisabled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("clears the trace deadline after a successful body read", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    vi.mocked(browserApiFetch).mockImplementationOnce(async (_path, init) => {
      fetchSignal = init?.signal ?? undefined;
      return new Response('{"type":"session"}\n');
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <SessionRightSidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Download trace" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(click).toHaveBeenCalledOnce();
    expect(fetchSignal?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchSignal?.aborted).toBe(false);
  });

  it("hides sandbox access controls when the capability is denied", () => {
    const sandboxSessionState: SessionState = {
      id: "session-1",
      title: "Viewer session",
      repoOwner: "acme",
      repoName: "web",
      baseBranch: "main",
      branchName: "viewer",
      status: "active",
      sandboxStatus: "ready",
      harness: "opencode",
      messageCount: 0,
      createdAt: 1,
      codeServerUrl: "https://code.example",
      vncUrl: "https://vnc.example",
      ttydUrl: "https://terminal.example",
      ttydToken: "secret",
      tunnelUrls: { app: "https://app.example" },
    };

    render(
      <SessionRightSidebar
        sessionId="session-1"
        sessionState={sandboxSessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={{ ...FULL_CAPABILITIES, sandboxAccess: false }}
      />
    );

    expect(screen.queryByText("Open Editor")).not.toBeInTheDocument();
    expect(screen.queryByText("Open Desktop")).not.toBeInTheDocument();
    expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
    expect(screen.queryByText("Port app")).not.toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
  });
  it("keeps its ARIA target mounted when closed", () => {
    render(
      <SessionRightSidebar
        isOpen={false}
        sessionId="session-1"
        sessionState={null}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    const sidebar = document.getElementById("session-details-sidebar");
    expect(sidebar).toBeInTheDocument();
    expect(sidebar).toHaveClass("hidden");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("details")).not.toBeInTheDocument();
  });

  it("forwards budget management to the desktop sidebar", () => {
    render(
      <SessionRightSidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
        canManageBudget
      />
    );

    expect(screen.getByRole("button", { name: "Edit limit" })).toBeInTheDocument();
  });

  it("does not render budget spacing when the budget section is hidden", () => {
    const { container } = render(
      <SessionRightSidebar
        sessionId="session-1"
        sessionState={{ ...sessionState, totalCost: 0, maxSessionCostUsd: null }}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    expect(screen.queryByText(/Session cost|No session cost limit/)).not.toBeInTheDocument();
    expect(container.querySelector(".mt-4")).not.toBeInTheDocument();
  });

  it("forwards budget management to the mobile overlay", () => {
    render(
      <SessionDetailsOverlay
        open
        isPhone
        onOpenChange={vi.fn()}
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
        canManageBudget
      />
    );

    expect(screen.getByRole("button", { name: "Edit limit" })).toBeInTheDocument();
  });
});
