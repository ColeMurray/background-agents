// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { Suspense } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EditAutomationPage from "./page";

expect.extend(matchers);

const CURRENT_USER_ID = "11111111111111111111111111111111";
let permissions: string[] = [];
const replace = vi.fn();

const automation = {
  id: "auto-1",
  name: "Nightly review",
  instructions: "Review the code",
  triggerType: "schedule" as const,
  scheduleCron: "0 9 * * *",
  scheduleTz: "UTC",
  model: "anthropic/claude-sonnet-4-6",
  reasoningEffort: null,
  enabled: true,
  nextRunAt: null,
  consecutiveFailures: 0,
  createdBy: CURRENT_USER_ID,
  userId: "22222222222222222222222222222222",
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  eventType: null,
  triggerConfig: null,
  repositories: [],
  environmentIds: [],
  providerSelections: {},
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
}));
vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => null,
  useSidebarContext: () => ({ isOpen: true }),
}));
vi.mock("@/hooks/use-automations", () => ({
  useAutomation: () => ({ automation, loading: false }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    authorization: { userId: CURRENT_USER_ID, permissions },
    loading: false,
  }),
}));
vi.mock("@/components/automations/automation-form", () => ({
  AutomationForm: () => <div>Automation edit form</div>,
}));

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <EditAutomationPage params={Promise.resolve({ id: "auto-1" })} />
      </Suspense>
    );
  });
}

beforeEach(() => {
  permissions = [];
  replace.mockReset();
});
afterEach(cleanup);

describe("EditAutomationPage authorization", () => {
  it("redirects an unauthorized own-scoped deep link without rendering the form", async () => {
    permissions = ["automations.manage.own"];
    await renderPage();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/automations/auto-1"));
    expect(screen.queryByText("Automation edit form")).not.toBeInTheDocument();
  });

  it("renders the form with automations.manage.any", async () => {
    permissions = ["automations.manage.any"];
    await renderPage();

    expect(await screen.findByText("Automation edit form")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
