// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { GitHubAutofixFeedback } from "@open-inspect/shared/types/github-autofix";
import type { SandboxEvent } from "@/types/session";
import { EventItem, SessionTimeline } from "./session-timeline";

expect.extend(matchers);
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

const review: Extract<GitHubAutofixFeedback, { kind: "review" }> = {
  version: 1,
  kind: "review",
  url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
  body: "### Summary\nPlease preserve the retry behavior.",
  comments: [
    {
      url: "https://github.com/acme/widgets/pull/42#discussion_r1",
      path: "src/retry.ts",
      line: 42,
      startLine: null,
      originalLine: 42,
      originalStartLine: null,
      side: "RIGHT",
      startSide: null,
      body: "Keep this retry atomic.",
      diffHunk: "@@ -42 +42 @@\n-old\n+new",
      diffHunkTruncated: false,
    },
  ],
};

function autofixEvent(
  feedback: GitHubAutofixFeedback = review
): Extract<SandboxEvent, { type: "user_message" }> {
  const origin =
    feedback.kind === "review"
      ? {
          kind: "review" as const,
          authorType: "bot" as const,
          feedbackUrl: feedback.url,
          feedback,
        }
      : {
          kind: "pr_comment" as const,
          authorType: "human" as const,
          feedbackUrl: feedback.url,
          feedback,
        };
  return {
    type: "user_message",
    content: "Hidden agent instructions.",
    messageId: "autofix-message",
    timestamp: 1,
    origin,
  };
}

const eventProps = {
  sessionId: "session-1",
  currentParticipantId: "participant-1",
  participantProfiles: {},
  onOpenMedia: () => {},
};

const timelineProps = {
  ...eventProps,
  isProcessing: false,
  loadingHistory: false,
  showSkeleton: false,
  onLoadOlder: () => {},
  promptQueue: [],
  onEditQueuedPrompt: () => {},
  onDeleteQueuedPrompt: () => {},
};

describe("session timeline Autofix feedback", () => {
  it("renders structured origin feedback with its provenance instead of agent instructions", () => {
    render(<EventItem {...eventProps} event={autofixEvent()} />);

    expect(screen.getByText("Resumed by PR feedback")).toBeInTheDocument();
    expect(screen.getByText("Review · Bot")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pull request review" })).toBeInTheDocument();
    expect(screen.getByText("Please preserve the retry behavior.")).toBeInTheDocument();
    expect(screen.queryByText("Hidden agent instructions.")).toBeNull();
  });

  it("copies visible structured feedback rather than agent instructions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("isSecureContext", true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<EventItem {...eventProps} event={autofixEvent()} />);

    await userEvent.click(screen.getByRole("button", { name: "Copy markdown" }));
    expect(writeText).toHaveBeenCalledWith(
      '### Summary\nPlease preserve the retry behavior.\n\n---\n\n### `"src/retry.ts"` L42 · RIGHT\n\nKeep this retry atomic.\n\nhttps://github.com/acme/widgets/pull/42#discussion_r1'
    );
  });

  it("parses persisted legacy prompts when structured origin data is absent", () => {
    const legacyPayload = JSON.stringify({
      url: review.url,
      body: review.body,
      comments: review.comments.map(({ url, path, line, startLine, body, diffHunk }) => ({
        url,
        path,
        line,
        startLine,
        body,
        diffHunk,
      })),
    });
    const event = autofixEvent();
    if (event.type !== "user_message" || !event.origin) throw new Error("Expected user message");
    delete event.origin.feedback;
    event.content = `Address feedback.\n\n<github_feedback_data>\n\n${legacyPayload}\n\n</github_feedback_data>`;

    render(<EventItem {...eventProps} event={event} />);

    expect(screen.getByRole("heading", { name: "Pull request review" })).toBeInTheDocument();
  });

  it("bounds malformed Autofix fallback without capping ordinary messages", () => {
    const malformed = autofixEvent();
    if (malformed.type !== "user_message" || !malformed.origin) {
      throw new Error("Expected user message");
    }
    delete malformed.origin.feedback;
    malformed.content = "x".repeat(10_000);
    const { container } = render(<EventItem {...eventProps} event={malformed} />);

    const fallback = container.querySelector("pre");
    expect(fallback?.textContent).toHaveLength(4_032);
    expect(fallback).toHaveClass("max-h-96", "overflow-auto");

    cleanup();
    const ordinary = { ...malformed, origin: undefined };
    const ordinaryContainer = render(<EventItem {...eventProps} event={ordinary} />).container;
    expect(ordinaryContainer.querySelector("pre")?.textContent).toHaveLength(10_000);
    expect(ordinaryContainer.querySelector("pre")).not.toHaveClass("max-h-96", "overflow-auto");
  });

  it("preserves thread expansion after virtualization unmounts its row", async () => {
    const events: SandboxEvent[] = [
      autofixEvent(),
      ...Array.from(
        { length: 500 },
        (_, index): SandboxEvent => ({
          type: "user_message",
          content: `Message ${index}`,
          messageId: `message-${index}`,
          timestamp: index + 2,
        })
      ),
    ];
    const { container } = render(<SessionTimeline {...timelineProps} events={events} />);
    const threadButton = screen.getByRole("button", {
      name: "Expand review comment on src/retry.ts L42 · RIGHT",
    });
    await userEvent.click(threadButton);

    const timeline = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, value: 500_000 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    await act(async () => {
      timeline.scrollTop = 400_000;
      fireEvent.scroll(timeline);
    });
    expect(screen.queryByRole("button", { name: /review comment on src\/retry\.ts/ })).toBeNull();

    await act(async () => {
      timeline.scrollTop = 0;
      fireEvent.scroll(timeline);
    });
    expect(
      screen.getByRole("button", { name: "Collapse review comment on src/retry.ts L42 · RIGHT" })
    ).toHaveAttribute("aria-expanded", "true");
  });
});
