// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDiffManifest } from "@open-inspect/shared/types/session-diffs";
import { SessionFileLinksProvider } from "@/lib/session-file-links";
import { SafeMarkdown } from "./safe-markdown";

const manifest: SessionDiffManifest = {
  version: 1,
  revisionId: "revision-1",
  capturedAt: 100,
  triggerMessageId: null,
  repositories: [
    {
      status: "ready",
      position: 0,
      repoOwner: "acme",
      repoName: "web",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      truncated: false,
      omittedFileCount: 0,
      files: [
        {
          id: "file-1",
          path: "docs/plans/parity.md",
          status: "modified",
          additions: 1,
          deletions: 0,
          renderState: "renderable",
        },
      ],
    },
  ],
};

function renderInSession(content: string, onOpen = vi.fn()) {
  render(
    <SessionFileLinksProvider manifest={manifest} onOpen={onOpen}>
      <SafeMarkdown content={content} />
    </SessionFileLinksProvider>
  );
  return onOpen;
}

afterEach(cleanup);

describe("SafeMarkdown links", () => {
  it("opens a changed file in the changes panel instead of navigating", () => {
    const onOpen = renderInSession("See [parity.md](docs/plans/parity.md).");
    const link = screen.getByRole("link", { name: "parity.md" });

    expect(link).not.toHaveAttribute("target");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, click);

    expect(click.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledWith({ repositoryPosition: 0, path: "docs/plans/parity.md" });
  });

  it("renders a repository file that is not in the diff as inert text", () => {
    const onOpen = renderInSession("See [notes.md](docs/notes.md).");

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const text = screen.getByText("notes.md");
    expect(text.tagName).toBe("SPAN");
    expect(text).toHaveAttribute("title", "Not in this session's changes");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps absolute URLs opening in a new tab inside a session", () => {
    const onOpen = renderInSession("[docs](https://example.com/docs/plans/parity.md)");
    const link = screen.getByRole("link", { name: "docs" });

    expect(link).toHaveAttribute("href", "https://example.com/docs/plans/parity.md");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    fireEvent.click(link);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("leaves anchor links unchanged inside a session", () => {
    renderInSession("[jump](#details)");

    expect(screen.getByRole("link", { name: "jump" })).toHaveAttribute("href", "#details");
  });

  it("renders relative links as before outside a session", () => {
    render(<SafeMarkdown content="See [parity.md](docs/plans/parity.md)." />);
    const link = screen.getByRole("link", { name: "parity.md" });

    expect(link).toHaveAttribute("href", "docs/plans/parity.md");
    expect(link).toHaveAttribute("target", "_blank");
  });
});
