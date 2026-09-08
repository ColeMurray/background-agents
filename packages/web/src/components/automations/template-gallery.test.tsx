// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ComponentProps } from "react";
import { TemplateGallery } from "./template-gallery";
import { getTemplatesForCategory, getVisibleCategories } from "@/lib/automation-templates";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

describe("TemplateGallery", () => {
  it("defaults to the Popular category and lists its templates", () => {
    render(<TemplateGallery />);
    for (const t of getTemplatesForCategory("popular")) {
      expect(screen.getByRole("heading", { name: t.title })).toBeInTheDocument();
    }
  });

  it("only renders categories that contain templates", () => {
    render(<TemplateGallery />);
    expect(screen.getAllByTestId(/^category-/)).toHaveLength(getVisibleCategories().length);
  });

  it("filters the grid when another category is selected (without navigation)", () => {
    render(<TemplateGallery />);
    // "Generate docs" is code-review only, so it is hidden under Popular.
    expect(screen.queryByRole("heading", { name: "Generate docs" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("category-code-review"));

    expect(screen.getByRole("heading", { name: "Generate docs" })).toBeInTheDocument();
    // A popular-only / non-code-review template is now hidden.
    expect(
      screen.queryByRole("heading", { name: "Weekly dependency digest" })
    ).not.toBeInTheDocument();
  });

  it("links each template's Add button to the prefilled create page", () => {
    render(<TemplateGallery />);
    const card = screen.getByRole("heading", { name: "Find bugs" }).closest("[data-template-id]");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByRole("link", { name: /add/i })).toHaveAttribute(
      "href",
      "/automations/new?template=find-bugs"
    );
  });

  it("gives each Add control a distinguishing accessible name", () => {
    render(<TemplateGallery />);
    expect(screen.getByRole("link", { name: "Add Find bugs" })).toHaveAttribute(
      "href",
      "/automations/new?template=find-bugs"
    );
  });

  it("shows a setup note for templates that need extra setup", () => {
    render(<TemplateGallery />);
    fireEvent.click(screen.getByTestId("category-security"));
    const card = screen
      .getByRole("heading", { name: "Scan codebase for vulnerabilities" })
      .closest("[data-template-id]");
    expect(within(card as HTMLElement).getByText(/requires slack/i)).toBeInTheDocument();
  });
});
