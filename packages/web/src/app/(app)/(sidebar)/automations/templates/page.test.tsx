// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AutomationTemplatesPage from "./page";

expect.extend(matchers);

let canCreate = true;
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => permission === "automations.create" && canCreate,
    loading: false,
  }),
}));

vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => null,
  useSidebarContext: () => ({ isOpen: true }),
}));

vi.mock("@/components/automations/template-gallery", () => ({
  TemplateGallery: () => <div>Template gallery</div>,
}));

beforeEach(() => {
  canCreate = true;
  replace.mockReset();
});

afterEach(cleanup);

describe("AutomationTemplatesPage", () => {
  it("renders templates with automations.create", () => {
    render(<AutomationTemplatesPage />);
    expect(screen.getByRole("heading", { name: "Automation templates" })).toBeInTheDocument();
  });

  it("redirects a direct template link without automations.create", () => {
    canCreate = false;
    render(<AutomationTemplatesPage />);

    expect(replace).toHaveBeenCalledWith("/automations");
    expect(screen.queryByRole("heading", { name: "Automation templates" })).not.toBeInTheDocument();
  });
});
