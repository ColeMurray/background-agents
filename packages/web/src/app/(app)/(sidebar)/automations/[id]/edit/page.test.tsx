// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EditAutomationPage from "./page";
import type { AutomationCapabilities } from "@open-inspect/shared/types/automations";
import type { AutomationFormValues } from "@/components/automations/automation-form";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { invalidateAutomationCache } from "@/lib/automation-cache";

expect.extend(matchers);

const CURRENT_USER_ID = "11111111111111111111111111111111";
let permissions: string[] = [];
const replace = vi.fn();
const push = vi.fn();
let search = "";
const formProps = vi.fn();
let submittedEnvironmentIds = ["env-1"];
let submittedRepositories: AutomationFormValues["repositories"] = [
  { repoOwner: "acme", repoName: "app" },
];

const NO_CAPABILITIES = { canRead: false, canManage: false, canTrigger: false };

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
  repositories: new Array<AutomationFormValues["repositories"][number]>(),
  environmentIds: new Array<string>(),
  providerSelections: {},
  capabilities: NO_CAPABILITIES as AutomationCapabilities,
  ownerTeamId: "team-1",
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => null,
  useSidebarContext: () => ({ isOpen: false }),
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
  AutomationForm: (props: {
    onSubmit: (values: AutomationFormValues) => void;
    initialValues: Partial<AutomationFormValues>;
  }) => {
    formProps(props);
    return (
      <div>
        Automation edit form
        <button
          onClick={() =>
            props.onSubmit({
              name: "Updated",
              harness: "opencode",
              model: "openai/gpt-5.4",
              reasoningEffort: null,
              triggerType: "schedule",
              instructions: "Review",
              repositories: submittedRepositories,
              environmentIds: submittedEnvironmentIds,
              providerSelections: {},
            })
          }
        >
          Save changes
        </button>
      </div>
    );
  },
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/automation-cache", () => ({ invalidateAutomationCache: vi.fn() }));

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
  search = "";
  formProps.mockClear();
  automation.capabilities = NO_CAPABILITIES;
  automation.environmentIds = [];
  automation.repositories = [];
  submittedEnvironmentIds = ["env-1"];
  submittedRepositories = [{ repoOwner: "acme", repoName: "app" }];
  replace.mockReset();
  push.mockReset();
  vi.mocked(invalidateAutomationCache).mockReset().mockResolvedValue(undefined);
  vi.mocked(browserApiFetch).mockReset();
  vi.mocked(browserApiFetch).mockResolvedValue(Response.json({}));
});
afterEach(cleanup);

describe("EditAutomationPage authorization", () => {
  it.each([
    { saved: ["env-1", "env-2"], submitted: ["env-2", "env-1"], unchanged: true },
    { saved: ["env-1"], submitted: [], unchanged: false },
  ])(
    "only sends a replacement for changed environment IDs ($saved -> $submitted)",
    async ({ saved, submitted, unchanged }) => {
      automation.environmentIds = saved;
      submittedEnvironmentIds = submitted;
      automation.capabilities = { canRead: true, canManage: true, canTrigger: false };
      await renderPage();
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(push).toHaveBeenCalledWith("/automations/auto-1"));
      const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
      if (unchanged) expect(body).not.toHaveProperty("environmentIds");
      else expect(body.environmentIds).toEqual(submitted);
      expect(body.repositories).toEqual([{ repoOwner: "acme", repoName: "app" }]);
    }
  );

  it.each([
    {
      saved: [{ repoOwner: "Acme", repoName: "App", baseBranch: "main" }],
      submitted: [{ repoOwner: "acme", repoName: "app", baseBranch: "main" }],
      unchanged: true,
    },
    {
      saved: [{ repoOwner: "acme", repoName: "app", baseBranch: "main" }],
      submitted: [{ repoOwner: "acme", repoName: "app", baseBranch: "release" }],
      unchanged: false,
    },
    {
      saved: [
        { repoOwner: "acme", repoName: "app", baseBranch: "main" },
        { repoOwner: "acme", repoName: "api", baseBranch: "main" },
      ],
      submitted: [
        { repoOwner: "acme", repoName: "api", baseBranch: "main" },
        { repoOwner: "acme", repoName: "app", baseBranch: "main" },
      ],
      unchanged: true,
    },
    {
      saved: [{ repoOwner: "acme", repoName: "app", baseBranch: "main" }],
      submitted: [{ repoOwner: "acme", repoName: "api", baseBranch: "main" }],
      unchanged: false,
    },
  ])(
    "only sends a replacement for changed repositories ($saved -> $submitted)",
    async ({ saved, submitted, unchanged }) => {
      automation.repositories = saved;
      submittedRepositories = submitted;
      automation.capabilities = { canRead: true, canManage: true, canTrigger: false };
      await renderPage();
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(push).toHaveBeenCalledWith("/automations/auto-1"));
      const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
      if (unchanged) expect(body).not.toHaveProperty("repositories");
      else expect(body.repositories).toEqual(submitted);
      expect(body.name).toBe("Updated");
    }
  );

  it("preserves navigation scope on back and save while editing the original owner", async () => {
    search = "teamId=team%2Fone";
    automation.capabilities = { canRead: true, canManage: true, canTrigger: false };
    await renderPage();
    expect(screen.getByRole("link", { name: "Back to automation" })).toHaveAttribute(
      "href",
      "/automations/auto-1?teamId=team%2Fone"
    );
    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialValues: expect.objectContaining({ teamId: "team-1" }) })
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/automations/auto-1?teamId=team%2Fone"));
    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/automations/auto-1",
      expect.objectContaining({ method: "PUT" })
    );
    const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty("teamId");
    expect(body.environmentIds).toEqual(["env-1"]);
    expect(invalidateAutomationCache).toHaveBeenCalledWith(expect.anything(), "auto-1");
  });

  it.each(["", "?teamId=team%2Fone"])(
    "redirects missing capabilities with global manage and scope %s",
    async (query) => {
      search = query.slice(1);
      permissions = ["automations.manage.any"];
      await renderPage();

      await waitFor(() => expect(replace).toHaveBeenCalledWith(`/automations/auto-1${query}`));
      expect(screen.queryByText("Automation edit form")).not.toBeInTheDocument();
    }
  );

  it("renders the form with server canManage", async () => {
    automation.capabilities = { canRead: true, canManage: true, canTrigger: false };
    await renderPage();

    expect(await screen.findByText("Automation edit form")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
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
    expect(invalidateAutomationCache).not.toHaveBeenCalled();
  });
});
