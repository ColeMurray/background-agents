// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AutomationTemplatesPage from "./page";

expect.extend(matchers);

let canCreate = true;
let search = "";
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search),
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => permission === "automations.create" && canCreate,
    loading: false,
  }),
}));

vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => null,
  useSidebarContext: () => ({ isOpen: false }),
}));

beforeEach(() => {
  canCreate = true;
  search = "";
  replace.mockReset();
});

afterEach(cleanup);

describe("AutomationTemplatesPage", () => {
  it("preserves scope for template creation and return links", () => {
    search = "teamId=team%2Fone";
    render(<AutomationTemplatesPage />);
    expect(screen.getByRole("link", { name: "Back to automations" })).toHaveAttribute(
      "href",
      "/automations?teamId=team%2Fone"
    );
    expect(screen.getByRole("link", { name: "Add Find bugs" })).toHaveAttribute(
      "href",
      "/automations/new?template=find-bugs&teamId=team%2Fone"
    );
  });

  it("renders templates with automations.create", () => {
    render(<AutomationTemplatesPage />);
    expect(screen.getByRole("heading", { name: "Automation templates" })).toBeInTheDocument();
  });

  it.each(["", "?teamId=team%2Fone"])("redirects a denied template link with scope %s", (query) => {
    search = query.slice(1);
    canCreate = false;
    render(<AutomationTemplatesPage />);

    expect(replace).toHaveBeenCalledWith(`/automations${query}`);
    expect(screen.queryByRole("heading", { name: "Automation templates" })).not.toBeInTheDocument();
  });
});
