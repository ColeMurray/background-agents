// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import type { GitHubAutofixFeedback } from "@/lib/github-autofix-feedback";
import { GitHubAutofixFeedbackCard } from "./github-autofix-feedback";

expect.extend(matchers);
afterEach(cleanup);

const review: Extract<GitHubAutofixFeedback, { kind: "review" }> = {
  version: 1,
  kind: "review",
  url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
  body: "### Summary\nPreserve the existing behavior.",
  comments: [
    {
      url: "https://github.com/acme/widgets/pull/42#discussion_r1",
      path: "src/widget.ts",
      line: 12,
      startLine: 10,
      originalLine: null,
      originalStartLine: null,
      side: null,
      startSide: null,
      body: "**Please fix:** keep `widgetId` stable.",
      diffHunk: "@@ -10,2 +10,2 @@\n-old value\n+new value",
      diffHunkTruncated: false,
    },
  ],
};

function FeedbackCard({ feedback = review }: { feedback?: GitHubAutofixFeedback }) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  return (
    <GitHubAutofixFeedbackCard
      feedback={feedback}
      messageId="message-1"
      expandedSections={expandedSections}
      onToggleSection={(key) => {
        setExpandedSections((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }}
    />
  );
}

describe("GitHubAutofixFeedbackCard", () => {
  it("renders exact review content and collapsed source threads", () => {
    render(<FeedbackCard />);

    expect(screen.getByRole("heading", { name: "Pull request review" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByText("Preserve the existing behavior.")).toBeInTheDocument();
    expect(screen.getAllByText("1 inline comment")).toHaveLength(2);
    expect(screen.getByText("src/widget.ts")).toBeInTheDocument();
    expect(screen.getByText("L10-L12")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Diff context for src/widget.ts" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand review comment on src/widget.ts L10-L12" })
    ).not.toHaveAttribute("aria-controls");
  });

  it("expands a thread to its diff and original Markdown body", async () => {
    const user = userEvent.setup();
    render(<FeedbackCard />);

    await user.click(
      screen.getByRole("button", { name: "Expand review comment on src/widget.ts L10-L12" })
    );

    expect(
      screen.getByRole("region", { name: "Diff context for src/widget.ts" })
    ).toBeInTheDocument();
    expect(screen.getByText("old value")).toBeInTheDocument();
    expect(screen.getByText("new value")).toBeInTheDocument();
    expect(screen.getByText("Please fix:")).toBeInTheDocument();
    expect(screen.getByText("widgetId")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open original thread" })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/pull/42#discussion_r1"
    );
  });

  it("offers disclosure for a long review body", async () => {
    const user = userEvent.setup();
    render(
      <FeedbackCard
        feedback={{
          ...review,
          body: `### Long review\n[Documentation](https://example.com/docs)\n${"Detailed feedback. ".repeat(50)}`,
        }}
      />
    );

    const disclosure = screen.getByRole("button", { name: "Show complete review" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Documentation" })).toBeNull();
    await user.click(disclosure);
    expect(disclosure).toHaveTextContent("Show less");
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Documentation" })).toBeInTheDocument();
  });

  it("bounds line-triggered disclosure content in the accessibility tree", async () => {
    const user = userEvent.setup();
    const body = [
      ...Array.from({ length: 14 }, (_, index) => `Line ${index + 1}`),
      "Hidden line",
    ].join("\n");
    render(<FeedbackCard feedback={{ ...review, body }} />);

    expect(screen.queryByText("Hidden line")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show complete review" }));
    expect(screen.getByText(/Hidden line/)).toBeInTheDocument();
  });

  it("resolves GitHub-relative links against the feedback URL", () => {
    render(
      <FeedbackCard
        feedback={{
          ...review,
          body: "See [issue](/acme/widgets/issues/123) and [details](#details).",
        }}
      />
    );

    expect(screen.getByRole("link", { name: "issue" })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/issues/123"
    );
    expect(screen.getByRole("link", { name: "details" })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/pull/42#details"
    );
  });

  it("renders image-only feedback as a safe non-interactive placeholder", async () => {
    const user = userEvent.setup();
    render(
      <FeedbackCard
        feedback={{
          ...review,
          comments: [
            {
              ...review.comments[0],
              body: "![failure](https://github.com/user-attachments/assets/failure.png)",
            },
          ],
        }}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Expand review comment on src/widget.ts L10-L12" })
    );
    expect(
      screen.getByText("failure: https://github.com/user-attachments/assets/failure.png")
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("does not create nested links for linked-image Markdown", async () => {
    const user = userEvent.setup();
    render(
      <FeedbackCard
        feedback={{
          ...review,
          comments: [
            {
              ...review.comments[0],
              body: "[![failure](https://github.com/user-attachments/assets/failure.png)](https://github.com/acme/widgets/actions)",
            },
          ],
        }}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Expand review comment on src/widget.ts L10-L12" })
    );
    const link = screen.getByRole("link", {
      name: "failure: https://github.com/user-attachments/assets/failure.png",
    });
    expect(link).toHaveAttribute("href", "https://github.com/acme/widgets/actions");
    expect(link.querySelector("a")).toBeNull();
  });

  it("renders pull request comments without a thread section", () => {
    render(
      <FeedbackCard
        feedback={{
          version: 1,
          kind: "pr_comment",
          url: "https://github.com/acme/widgets/pull/42#issuecomment-1",
          body: "Please update the documentation.",
        }}
      />
    );

    expect(screen.getByRole("heading", { name: "Pull request comment" })).toBeInTheDocument();
    expect(screen.getByText("Please update the documentation.")).toBeInTheDocument();
    expect(screen.queryByText(/inline comment/)).toBeNull();
  });

  it("renders collapsed Markdown as inert text", () => {
    render(
      <FeedbackCard
        feedback={{
          ...review,
          comments: [
            {
              ...review.comments[0],
              body: "See [the documentation](https://example.com/docs) before changing this.",
            },
          ],
        }}
      />
    );

    expect(screen.queryByRole("link", { name: "the documentation" })).toBeNull();
    expect(screen.getByText(/\[the documentation\]/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand review comment on src/widget.ts L10-L12" })
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("preserves source whitespace in rendered diff lines", async () => {
    const user = userEvent.setup();
    render(
      <FeedbackCard
        feedback={{
          ...review,
          comments: [
            {
              ...review.comments[0],
              diffHunk: "@@ -10 +10 @@ function example() {\n+  const  value = true;",
            },
          ],
        }}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Expand review comment on src/widget.ts L10-L12" })
    );
    const diff = screen.getByRole("region", { name: "Diff context for src/widget.ts" });
    expect(diff).toHaveAttribute("tabindex", "0");
    diff.focus();
    expect(diff).toHaveFocus();
    const code = screen.getByText((_, element) =>
      Boolean(element?.tagName === "CODE" && element.textContent === "  const  value = true;")
    );
    expect(code).toHaveClass("whitespace-pre");
  });

  it("discloses producer-truncated diff context", async () => {
    const user = userEvent.setup();
    render(
      <FeedbackCard
        feedback={{
          ...review,
          comments: [{ ...review.comments[0], diffHunkTruncated: true }],
        }}
      />
    );

    const button = screen.getByRole("button", {
      name: "Expand review comment on src/widget.ts L10-L12",
    });
    await user.click(button);
    expect(button).toHaveAttribute("aria-controls");
    expect(screen.getByText("Diff context truncated by Open Inspect")).toBeInTheDocument();
  });

  it("renders large comment collections in bounded batches", async () => {
    const user = userEvent.setup();
    const comments = Array.from({ length: 11 }, (_, index) => ({
      ...review.comments[0],
      url: `https://github.com/acme/widgets/pull/42#discussion_r${index}`,
      path: `src/widget-${index}.ts`,
    }));
    render(<FeedbackCard feedback={{ ...review, comments }} />);

    expect(screen.getAllByRole("button", { name: /Expand review comment/ })).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: "Show all 11 comments" }));
    expect(screen.getAllByRole("button", { name: /Expand review comment/ })).toHaveLength(11);
  });

  it("labels long pull request comment disclosure as a comment", () => {
    render(
      <FeedbackCard
        feedback={{
          version: 1,
          kind: "pr_comment",
          url: "https://github.com/acme/widgets/pull/42#issuecomment-1",
          body: "Long comment. ".repeat(60),
        }}
      />
    );

    expect(screen.getByRole("button", { name: "Show complete comment" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByRole("button", { name: "Show complete review" })).toBeNull();
  });
});
