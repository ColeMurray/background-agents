// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueuedPromptStack } from "./queued-prompt-stack";

expect.extend(matchers);

afterEach(cleanup);

describe("QueuedPromptStack", () => {
  it("renders only pending prompts in FIFO order", () => {
    render(
      <QueuedPromptStack
        cancellingPromptIds={new Set()}
        onRemove={vi.fn()}
        promptQueue={[
          { messageId: "running", content: "Already running", status: "processing" },
          { messageId: "next", content: "Run next", status: "pending" },
          { messageId: "later", content: "Run after that", status: "pending" },
        ]}
      />
    );

    expect(screen.queryByText("Already running")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Run next",
      "Run after that",
    ]);
    expect(screen.getAllByRole("button", { name: /Remove queued prompt:/ })).toHaveLength(2);
  });

  it("does not render when the queue has no pending prompts", () => {
    const { container } = render(
      <QueuedPromptStack
        cancellingPromptIds={new Set()}
        onRemove={vi.fn()}
        promptQueue={[{ messageId: "running", content: "Already running", status: "processing" }]}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("removes the selected prompt and disables duplicate removal", () => {
    const onRemove = vi.fn();
    render(
      <QueuedPromptStack
        promptQueue={[{ messageId: "next", content: "Run next", status: "pending" }]}
        cancellingPromptIds={new Set(["next"])}
        onRemove={onRemove}
      />
    );

    const remove = screen.getByRole("button", { name: "Remove queued prompt: Run next" });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("passes the queued message id to the remove callback", () => {
    const onRemove = vi.fn();
    render(
      <QueuedPromptStack
        promptQueue={[{ messageId: "next", content: "Run next", status: "pending" }]}
        cancellingPromptIds={new Set()}
        onRemove={onRemove}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove queued prompt: Run next" }));
    expect(onRemove).toHaveBeenCalledWith("next");
  });

  it("offers removal for pending prompts whose eligibility is server-owned", () => {
    const onRemove = vi.fn();
    render(
      <QueuedPromptStack
        promptQueue={[
          {
            messageId: "linear-prompt",
            content: "Reply in Linear",
            status: "pending",
          },
        ]}
        cancellingPromptIds={new Set()}
        onRemove={onRemove}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove queued prompt: Reply in Linear" }));
    expect(onRemove).toHaveBeenCalledWith("linear-prompt");
  });
});
