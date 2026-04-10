// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { ActionBar } from "./action-bar";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

describe("ActionBar", () => {
  it("renders View PR for hydrated PR artifacts", () => {
    render(
      <ActionBar
        sessionId="session-1"
        sessionStatus="active"
        artifacts={[
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: {
              prNumber: 42,
              prState: "open",
              head: "feature/test",
              base: "main",
            },
            createdAt: 1234,
          },
        ]}
      />
    );

    const link = screen.getByRole("link", { name: /view pr/i });
    expect(link).toHaveAttribute("href", "https://github.com/acme/web-app/pull/42");
  });
});
