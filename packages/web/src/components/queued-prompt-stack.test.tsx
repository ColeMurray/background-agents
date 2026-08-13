// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import { QueuedPromptStack } from "./queued-prompt-stack";

expect.extend(matchers);

afterEach(cleanup);

describe("QueuedPromptStack", () => {
  it("renders only pending prompts in FIFO order", () => {
    render(
      <QueuedPromptStack
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
  });

  it("does not render when the queue has no pending prompts", () => {
    const { container } = render(
      <QueuedPromptStack
        promptQueue={[{ messageId: "running", content: "Already running", status: "processing" }]}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
