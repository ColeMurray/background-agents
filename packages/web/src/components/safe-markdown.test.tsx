// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDiffManifest } from "@open-inspect/shared/types/session-diffs";
import { SessionFileLinksProvider } from "@/lib/session-file-links";
import { CreatePullRequestEvent } from "./create-pull-request-event";
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
        {
          id: "file-2",
          path: "README.md",
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
      <SafeMarkdown content={content} linkRepositoryFiles />
    </SessionFileLinksProvider>
  );
  return onOpen;
}

afterEach(cleanup);

describe("SafeMarkdown links", () => {
  it("opens a changed file in the changes panel from a button, not a link", () => {
    const onOpen = renderInSession("See [parity.md](docs/plans/parity.md).");

    expect(screen.queryByRole("link", { name: "parity.md" })).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "parity.md" });
    fireEvent.click(button);

    expect(onOpen).toHaveBeenCalledWith(
      { repositoryPosition: 0, path: "docs/plans/parity.md" },
      button
    );
  });

  it("opens a root-level file referenced with a line number", () => {
    const onOpen = renderInSession("See [README](README.md:42).");

    fireEvent.click(screen.getByRole("button", { name: "README" }));
    expect(onOpen).toHaveBeenCalledWith(
      { repositoryPosition: 0, path: "README.md" },
      expect.any(HTMLButtonElement)
    );
  });

  it("opens a root-level file from a reference-style link with a line number", () => {
    const onOpen = renderInSession("See [README][r].\n\n[r]: README.md:42");

    fireEvent.click(screen.getByRole("button", { name: "README" }));
    expect(onOpen).toHaveBeenCalledWith(
      { repositoryPosition: 0, path: "README.md" },
      expect.any(HTMLButtonElement)
    );
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

  it("keeps sanitized mailto links as plain text inside a session", () => {
    renderInSession("Contact [support](mailto:support@example.com).");

    expect(screen.queryByRole("link", { name: "support" })).not.toBeInTheDocument();
    expect(screen.getByText("support")).toHaveProperty("tagName", "SPAN");
  });

  it("keeps plain links when a session markdown block does not opt in", () => {
    render(
      <SessionFileLinksProvider manifest={manifest} onOpen={vi.fn()}>
        <SafeMarkdown content="See [parity.md](docs/plans/parity.md)." />
      </SessionFileLinksProvider>
    );

    expect(screen.getByRole("link", { name: "parity.md" })).toHaveAttribute("target", "_blank");
  });

  it("leaves relative links in a pull request body alone inside a session", () => {
    const onOpen = vi.fn();
    render(
      <SessionFileLinksProvider manifest={manifest} onOpen={onOpen}>
        <CreatePullRequestEvent
          event={{
            type: "tool_call",
            tool: "create-pull-request",
            callId: "call-1",
            messageId: "message-1",
            sandboxId: "sandbox-1",
            timestamp: 1_700_000_000,
            status: "completed",
            args: {
              title: "Plan",
              body: "See [parity.md](docs/plans/parity.md).",
              repo: "acme/web",
            },
          }}
          isExpanded
          onToggle={() => {}}
        />
      </SessionFileLinksProvider>
    );

    const link = screen.getByRole("link", { name: "parity.md" });
    expect(link).toHaveAttribute("href", "docs/plans/parity.md");
    expect(link).toHaveAttribute("target", "_blank");
    fireEvent.click(link);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders relative links as before outside a session", () => {
    render(<SafeMarkdown content="See [parity.md](docs/plans/parity.md)." linkRepositoryFiles />);
    const link = screen.getByRole("link", { name: "parity.md" });

    expect(link).toHaveAttribute("href", "docs/plans/parity.md");
    expect(link).toHaveAttribute("target", "_blank");
  });
});

describe("SafeMarkdown untrusted documents", () => {
  it("renders formatting without executing html, unsafe urls, relative links, or images", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <SessionFileLinksProvider manifest={manifest} onOpen={onOpen}>
        <SafeMarkdown
          untrustedDocument
          content={[
            "# Details",
            "",
            "A **bold** paragraph with ~~gone~~ text.",
            "",
            "- one",
            "",
            "> quoted",
            "",
            "`inline`",
            "",
            "```ts",
            "const n = 1;",
            "```",
            "",
            "| A | B |",
            "| - | - |",
            "| 1 | 2 |",
            "",
            "See [docs](https://example.com/docs) and [local](docs/guide.md).",
            "",
            "[jump](#details)",
            "",
            "[click](javascript:alert(1))",
            "",
            "![diagram](./secret.png)",
            "",
            "<script>alert(1)</script>",
            "",
            '<iframe src="https://evil.example"></iframe>',
            "",
          ].join("\n")}
        />
      </SessionFileLinksProvider>
    );

    expect(screen.getByRole("heading", { name: "Details" })).toBeVisible();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("gone").tagName).toBe("DEL");
    expect(screen.getByRole("listitem")).toHaveTextContent("one");
    expect(screen.getByRole("table")).toBeVisible();
    expect(container.querySelector("pre")).toHaveClass("overflow-x-auto");
    expect(container.querySelector("blockquote")).toBeTruthy();
    expect(container.querySelector("script, iframe, img")).toBeNull();

    const external = screen.getByRole("link", { name: "docs" });
    expect(external).toHaveAttribute("href", "https://example.com/docs");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer nofollow");

    expect(screen.queryByRole("link", { name: "local" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "click" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "local" })).not.toBeInTheDocument();
    expect(screen.getByText("local")).toHaveProperty("tagName", "SPAN");
    expect(screen.getByText("diagram: ./secret.png")).toBeVisible();

    const jump = screen.getByRole("link", { name: "jump" });
    const heading = screen.getByRole("heading", { name: "Details" });
    expect(jump).toHaveAttribute("href", `#${heading.id}`);
    expect(jump).not.toHaveAttribute("target");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("numbers duplicate headings sequentially under StrictMode", () => {
    render(
      <StrictMode>
        <SafeMarkdown
          untrustedDocument
          content={["# Setup", "", "## Setup", "", "[second](#setup-1)", ""].join("\n")}
        />
      </StrictMode>
    );

    const [first, second] = screen.getAllByRole("heading", { name: "Setup" });
    expect(second.id).toBe(`${first.id}-1`);
    expect(screen.getByRole("link", { name: "second" })).toHaveAttribute("href", `#${second.id}`);
  });
});
