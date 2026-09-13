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

const review: GitHubAutofixFeedback = {
  kind: "review",
  url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
  body: "### Summary\nPreserve the existing behavior.",
  comments: [
    {
      url: "https://github.com/acme/widgets/pull/42#discussion_r1",
      path: "src/widget.ts",
      line: 12,
      startLine: 10,
      body: "**Please fix:** keep `widgetId` stable.",
      diffHunk: "@@ -10,2 +10,2 @@\n-old value\n+new value",
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
        feedback={{ ...review, body: `### Long review\n${"Detailed feedback. ".repeat(50)}` }}
      />
    );

    const disclosure = screen.getByRole("button", { name: "Show complete review" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await user.click(disclosure);
    expect(disclosure).toHaveTextContent("Show less");
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
  });

  it("renders pull request comments without a thread section", () => {
    render(
      <FeedbackCard
        feedback={{
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

  it("keeps links in collapsed Markdown outside the thread button", () => {
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

    const link = screen.getByRole("link", { name: "the documentation" });
    expect(link.closest("button")).toBeNull();
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
