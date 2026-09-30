// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { SWRConfig, mutate } from "swr";
import type * as SwrModule from "swr";
import type { SessionDiffState } from "@open-inspect/shared/types/session-diffs";
import type { SessionCapabilities } from "@/lib/session-capabilities";

const FULL_CAPABILITIES = {
  read: true,
  collaborate: true,
  lifecycle: true,
  sandboxAccess: true,
  exportTrace: true,
} satisfies SessionCapabilities;

vi.mock("next/dynamic", () => ({
  default:
    () => (props: { patch: string; diffStyle: string; wrap: boolean; themeType: string }) => (
      <div
        data-testid="diff-renderer"
        data-style={props.diffStyle}
        data-wrap={String(props.wrap)}
        data-theme={props.themeType}
      >
        {props.patch}
      </div>
    ),
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
const layout = vi.hoisted(() => ({ width: 900 }));
vi.mock("@/hooks/use-panel-width", () => ({ usePanelWidth: () => layout.width }));
vi.mock("swr", async (importOriginal) => ({
  ...(await importOriginal<typeof SwrModule>()),
  mutate: vi.fn(),
}));

import { SessionChangesPanel } from "./session-changes-panel";

beforeEach(() => {
  layout.width = 900;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const state: SessionDiffState = {
  version: 1,
  lastError: null,
  unavailableReason: null,
  current: {
    version: 1,
    revisionId: "revision-1",
    capturedAt: 100,
    triggerMessageId: "message-1",
    repositories: [
      {
        position: 0,
        repoOwner: "acme",
        repoName: "web",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        status: "ready",
        truncated: true,
        omittedFileCount: 2,
        files: [
          {
            id: "file-1",
            path: "src/app.ts",
            status: "modified",
            additions: 2,
            deletions: 1,
            renderState: "metadata_only",
            oldMode: "100644",
            newMode: "100755",
          },
          {
            id: "file-2",
            path: "src/lib.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            renderState: "metadata_only",
          },
        ],
      },
    ],
  },
};
const readyRepository = state.current!.repositories[0]!;
if (readyRepository.status !== "ready") throw new Error("Expected a ready repository fixture");

const patchFile = { ...readyRepository.files[0]!, renderState: "renderable" as const };
const patchRepository = { ...readyRepository, files: [patchFile, readyRepository.files[1]!] };
function patchPanel(overrides: Partial<ComponentProps<typeof SessionChangesPanel>> = {}) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}
    >
      <SessionChangesPanel
        sessionId="session-1"
        capabilities={FULL_CAPABILITIES}
        state={{ ...state, current: { ...state.current!, repositories: [patchRepository] } }}
        resolved={{
          status: "ready",
          revisionId: "revision-1",
          repository: patchRepository,
          file: patchFile,
        }}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        {...overrides}
      />
    </SWRConfig>
  );
}

describe("SessionChangesPanel", () => {
  it("keeps searchable file navigation and selected-file context in the panel", async () => {
    const onSelect = vi.fn();
    render(
      <SessionChangesPanel
        sessionId="session-1"
        capabilities={FULL_CAPABILITIES}
        state={state}
        resolved={{
          status: "ready",
          revisionId: "revision-1",
          repository: readyRepository,
          file: readyRepository.files[0]!,
        }}
        onClose={vi.fn()}
        onSelect={onSelect}
      />
    );

    expect(screen.getByText("acme/web")).toBeVisible();
    expect(screen.getByLabelText("File change summary")).toHaveTextContent(/modified.*\+2.*-1/i);
    expect(screen.getByLabelText("File position")).toHaveTextContent("1 / 2");
    expect(screen.getByText("Compared with session start")).toBeVisible();
    expect(screen.getByText(/2 additional files omitted/i)).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Changed files" })).toHaveClass("w-56");
    await userEvent.click(screen.getByRole("button", { name: /lib\.ts.*modified/i }));
    expect(onSelect).toHaveBeenCalledWith({ repositoryPosition: 0, path: "src/lib.ts" });
  });

  it("collapses and reopens the changed-files sidebar", async () => {
    render(
      <SessionChangesPanel
        sessionId="session-1"
        capabilities={FULL_CAPABILITIES}
        state={state}
        resolved={{
          status: "ready",
          revisionId: "revision-1",
          repository: readyRepository,
          file: readyRepository.files[0]!,
        }}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const sidebar = screen.getByRole("complementary", { name: "Changed files" });
    const hideButton = screen.getByRole("button", { name: "Hide file list" });
    expect(hideButton).toHaveAttribute("aria-expanded", "true");
    expect(hideButton).toHaveAttribute("aria-controls", sidebar.id);

    await userEvent.click(hideButton);

    expect(sidebar).not.toBeVisible();
    const showButton = screen.getByRole("button", { name: "Show file list" });
    expect(showButton).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(showButton);

    expect(sidebar).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide file list" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("preserves the file filter while the sidebar is collapsed", async () => {
    render(
      <SessionChangesPanel
        sessionId="session-1"
        capabilities={FULL_CAPABILITIES}
        state={state}
        resolved={{
          status: "ready",
          revisionId: "revision-1",
          repository: readyRepository,
          file: readyRepository.files[0]!,
        }}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    const filter = screen.getByRole("searchbox", { name: "Filter changed files" });
    await userEvent.type(filter, "lib");
    await userEvent.click(screen.getByRole("button", { name: "Hide file list" }));
    await userEvent.click(screen.getByRole("button", { name: "Show file list" }));

    expect(filter).toHaveValue("lib");
    expect(screen.queryByRole("button", { name: /app\.ts.*modified/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /lib\.ts.*modified/i })).toBeVisible();
  });

  it("keeps navigation available when a selected file disappears", () => {
    render(
      <SessionChangesPanel
        sessionId="session-1"
        capabilities={FULL_CAPABILITIES}
        state={state}
        resolved={{ status: "missing", revisionId: "revision-1" }}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole("searchbox", { name: "Filter changed files" })).toBeVisible();
    expect(screen.getByRole("button", { name: /app\.ts.*modified/i })).toBeVisible();
    expect(screen.getByText(/no longer part of the latest/i)).toBeVisible();
  });

  it("supports file-list collapsing with a unified-only diff control on mobile", async () => {
    render(
      <SessionChangesPanel
        mobile
        sessionId="session-1"
        capabilities={FULL_CAPABILITIES}
        state={state}
        resolved={{
          status: "ready",
          revisionId: "revision-1",
          repository: readyRepository,
          file: readyRepository.files[0]!,
        }}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Unified" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Split" })).toBeDisabled();
    expect(screen.queryByRole("complementary", { name: "Changed files" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show file list" }));
    const sidebar = screen.getByRole("complementary", { name: "Changed files" });
    expect(sidebar).toBeVisible();
    expect(sidebar).toHaveClass("max-h-[40dvh]");
    await userEvent.click(screen.getByRole("button", { name: /lib\.ts.*modified/i }));
    expect(sidebar).not.toBeVisible();
    expect(screen.getByRole("region", { name: "Session changes" })).toHaveFocus();
  });

  it("reports an authoritative retry failure from the explicit retry endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "Sandbox is not connected" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SessionChangesPanel
        sessionId="session-1"
        capabilities={FULL_CAPABILITIES}
        state={{
          ...state,
          lastError: { message: "timed out", occurredAt: 200 },
        }}
        resolved={{
          status: "ready",
          revisionId: "revision-1",
          repository: readyRepository,
          file: readyRepository.files[0]!,
        }}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/diff/retry", {
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
    });
    expect(await screen.findByText("Sandbox is not connected")).toBeVisible();
  });

  it("loads the revision-specific patch and preserves layout preferences across widths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("+review this code"));
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("session-changes.diff-style", "split");
    localStorage.setItem("session-changes.wrap", "false");
    const view = render(patchPanel());
    const renderer = await screen.findByTestId("diff-renderer");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/diff/revision-1/files/file-1", {
      mode: "same-origin",
      credentials: "same-origin",
    });
    expect(renderer).toHaveTextContent("+review this code");
    expect(renderer).toHaveAttribute("data-style", "split");
    expect(renderer).toHaveAttribute("data-wrap", "false");
    expect(renderer).toHaveAttribute("data-theme", "dark");
    layout.width = 500;
    view.rerender(patchPanel());
    expect(screen.getByRole("button", { name: "Split" })).toBeDisabled();
    expect(renderer).toHaveAttribute("data-style", "unified");
    expect(localStorage.getItem("session-changes.diff-style")).toBe("split");
    layout.width = 900;
    view.rerender(patchPanel());
    expect(renderer).toHaveAttribute("data-style", "split");
    await userEvent.click(screen.getByRole("checkbox", { name: "Wrap lines" }));
    expect(renderer).toHaveAttribute("data-wrap", "true");
  });

  it("leaves the file list to the details sidebar until the viewer opens it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const view = render(patchPanel({ sidebarShowsFileList: true }));
    expect(screen.queryByRole("complementary", { name: "Changed files" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show file list" }));
    expect(screen.getByRole("complementary", { name: "Changed files" })).toBeVisible();

    // The viewer's choice holds even if the sidebar closes afterwards.
    view.rerender(patchPanel({ sidebarShowsFileList: false }));
    await userEvent.click(screen.getByRole("button", { name: "Hide file list" }));
    view.rerender(patchPanel({ sidebarShowsFileList: false }));
    expect(screen.queryByRole("complementary", { name: "Changed files" })).not.toBeInTheDocument();
  });

  it("shows its own file list once the sidebar stops listing the files", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const view = render(patchPanel({ sidebarShowsFileList: true }));
    expect(screen.queryByRole("complementary", { name: "Changed files" })).not.toBeInTheDocument();

    // For example, the viewer switches the sidebar to Info while the diff stays open.
    view.rerender(patchPanel({ sidebarShowsFileList: false }));
    expect(screen.getByRole("complementary", { name: "Changed files" })).toBeVisible();
  });

  it("shows a loading state while the patch is pending", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(patchPanel());
    expect(screen.getByText("Loading patch…")).toBeVisible();
  });

  it.each([
    [() => new Response("", { status: 500 }), "Unable to load this patch."],
    [() => new Response(""), "This patch is empty."],
    [
      () => Response.json({ code: "diff_revision_stale" }, { status: 409 }),
      "Refreshing the latest revision…",
    ],
  ])("keeps patch failure and empty states distinct %#", async (response, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    render(patchPanel());
    expect(await screen.findByText(message)).toBeVisible();
    if (message.startsWith("Refreshing"))
      await waitFor(() => expect(mutate).toHaveBeenCalledWith("/api/sessions/session-1/diff"));
  });

  it.each([
    ["binary", "This binary file changed, but it does not have a text diff."],
    ["too_large", "This patch is too large to display safely."],
    ["metadata_only", "File metadata changed (100644 → 100755)."],
  ] as const)("does not fetch %s files", (renderState, message) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      patchPanel({
        resolved: {
          status: "ready",
          revisionId: "revision-1",
          repository: patchRepository,
          file: { ...patchFile, renderState },
        },
      })
    );
    expect(screen.getByText(message)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps previous/next boundaries and Escape dismissal", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      patchPanel({
        onSelect,
        onClose,
        resolved: {
          status: "ready",
          revisionId: "revision-1",
          repository: readyRepository,
          file: readyRepository.files[0]!,
        },
      })
    );
    expect(screen.getByRole("button", { name: "Previous changed file" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next changed file" }));
    expect(onSelect).toHaveBeenCalledWith({ repositoryPosition: 0, path: "src/lib.ts" });
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
