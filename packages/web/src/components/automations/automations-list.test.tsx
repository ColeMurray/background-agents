// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ComponentProps } from "react";
import { AutomationsList } from "./automations-list";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

const noop = () => {};

describe("AutomationsList empty state", () => {
  it("offers a template path and a from-scratch path when there are no automations", () => {
    render(
      <AutomationsList
        automations={[]}
        onPause={noop}
        onResume={noop}
        onTrigger={noop}
        onDelete={noop}
      />
    );

    expect(screen.getByRole("link", { name: /start from a template/i })).toHaveAttribute(
      "href",
      "/automations/templates"
    );
    expect(screen.getByRole("link", { name: /create automation/i })).toHaveAttribute(
      "href",
      "/automations/new"
    );
  });
});
