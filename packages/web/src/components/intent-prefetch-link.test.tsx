// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it, vi } from "vitest";
import { IntentPrefetchLink } from "./intent-prefetch-link";

expect.extend(matchers);

vi.mock("next/link", () => ({
  default: ({
    prefetch,
    children,
    ...props
  }: React.ComponentProps<"a"> & { prefetch?: boolean | null }) => (
    <a data-prefetch={String(prefetch)} {...props}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

it("disables prefetching before user intent", () => {
  render(<IntentPrefetchLink href="/session/test-session">Session</IntentPrefetchLink>);

  const link = screen.getByRole("link", { name: "Session" });
  expect(link).toHaveAttribute("data-prefetch", "false");
  expect(link).toHaveAttribute("href", "/session/test-session");
});

it.each(["mouseEnter", "focus", "touchStart"] as const)(
  "enables auto prefetch on %s and calls the caller's handler once",
  (eventName) => {
    const onIntent = vi.fn();
    render(
      <IntentPrefetchLink
        href="/session/test-session"
        onMouseEnter={onIntent}
        onFocus={onIntent}
        onTouchStart={onIntent}
      >
        Session
      </IntentPrefetchLink>
    );

    const link = screen.getByRole("link", { name: "Session" });
    fireEvent[eventName](link);

    expect(link).toHaveAttribute("data-prefetch", "null");
    expect(onIntent).toHaveBeenCalledOnce();
  }
);

it("keeps prefetch enabled after intent without requiring caller handlers", () => {
  render(<IntentPrefetchLink href="/session/test-session">Session</IntentPrefetchLink>);

  const link = screen.getByRole("link", { name: "Session" });
  fireEvent.mouseEnter(link);
  fireEvent.mouseLeave(link);

  expect(link).toHaveAttribute("data-prefetch", "null");
});
