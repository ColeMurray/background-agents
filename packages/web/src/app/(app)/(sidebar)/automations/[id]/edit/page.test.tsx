// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EditAutomationPage from "./page";
import type { Automation } from "@open-inspect/shared/types/automations";
import type { AutomationFormValues } from "@/components/automations/automation-form";
import { browserApiFetch } from "@/lib/browser-api-fetch";

expect.extend(matchers);

const CURRENT_USER_ID = "11111111111111111111111111111111";
let permissions: string[] = [];
const replace = vi.fn();
const push = vi.fn();
const cacheMocks = vi.hoisted(() => ({ mutate: vi.fn() }));

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
  capabilities: undefined as Automation["capabilities"],
  ownerTeamId: "team-1",
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
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
  AutomationForm: ({ onSubmit }: { onSubmit: (values: AutomationFormValues) => void }) => (
    <div>
      Automation edit form
      <button
        onClick={() =>
          onSubmit({
            name: "Updated",
            harness: "opencode",
            model: "openai/gpt-5.4",
            reasoningEffort: null,
            triggerType: "schedule",
            instructions: "Review",
            repositories: [{ repoOwner: "acme", repoName: "app" }],
            environmentIds: ["env-1"],
            providerSelections: {},
          })
        }
      >
        Save changes
      </button>
    </div>
  ),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: cacheMocks.mutate }) }));

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
  automation.capabilities = undefined;
  replace.mockReset();
  push.mockReset();
  cacheMocks.mutate.mockReset();
  cacheMocks.mutate.mockResolvedValue(undefined);
  vi.mocked(browserApiFetch).mockReset();
  vi.mocked(browserApiFetch).mockResolvedValue(Response.json({}));
});
afterEach(cleanup);

describe("EditAutomationPage authorization", () => {
  it("redirects a deep link with missing capabilities even with global manage", async () => {
    permissions = ["automations.manage.any"];
    await renderPage();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/automations/auto-1"));
    expect(screen.queryByText("Automation edit form")).not.toBeInTheDocument();
  });

  it("renders the form with server canManage", async () => {
    automation.capabilities = { canRead: true, canManage: true, canTrigger: false };
    await renderPage();

    expect(await screen.findByText("Automation edit form")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("saves configuration without resubmitting team ownership", async () => {
    automation.capabilities = { canRead: true, canManage: true, canTrigger: false };
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/automations/auto-1"));
    const calls = vi.mocked(browserApiFetch).mock.calls;
    expect(calls.map(([path]) => path)).toEqual(["/api/automations/auto-1"]);
    expect(JSON.parse(String(calls[0][1]?.body))).not.toHaveProperty("teamId");
    expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({
      repositories: [{ repoOwner: "acme", repoName: "app" }],
      environmentIds: ["env-1"],
    });
  });

  it("reports configuration failures without navigating away", async () => {
    automation.capabilities = { canRead: true, canManage: true, canTrigger: false };
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ error: "Update denied" }, { status: 403 })
    );
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Update denied");
    expect(vi.mocked(browserApiFetch).mock.calls.map(([path]) => path)).toEqual([
      "/api/automations/auto-1",
    ]);
    expect(push).not.toHaveBeenCalled();
    expect(cacheMocks.mutate).not.toHaveBeenCalled();
  });
});
