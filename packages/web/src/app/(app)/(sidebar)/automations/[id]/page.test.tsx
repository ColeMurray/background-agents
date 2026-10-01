// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_AUTOMATION_INVOCATION_LIST_LIMIT,
  type Automation,
} from "@open-inspect/shared/types/automations";
import AutomationDetailPage from "./page";
import { browserApiFetch } from "@/lib/browser-api-fetch";

expect.extend(matchers);

const CURRENT_USER_ID = "11111111111111111111111111111111";
const OTHER_USER_ID = "22222222222222222222222222222222";
let permissions: string[] = [];
let search = "";
const push = vi.fn();
/** How many invocations the automation has, and every limit the page asked for. */
const history = vi.hoisted(() => ({ total: 0, requestedLimits: [] as number[] }));

const automation = {
  id: "auto-1",
  name: "Nightly review",
  instructions: "Review the code",
  harness: "opencode",
  triggerType: "schedule" as const,
  scheduleCron: "0 9 * * *",
  scheduleTz: "UTC",
  model: "anthropic/claude-sonnet-4-6",
  reasoningEffort: null,
  enabled: true,
  nextRunAt: null,
  consecutiveFailures: 0,
  createdBy: CURRENT_USER_ID,
  userId: OTHER_USER_ID,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  eventType: null,
  triggerConfig: null,
  repositories: [],
  environmentIds: [],
  providerSelections: {},
  capabilities: undefined as Automation["capabilities"],
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}));
vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => null,
  useSidebarContext: () => ({ isOpen: false }),
}));
vi.mock("@/hooks/use-automations", () => ({
  useAutomation: () => ({ automation, loading: false, mutate: vi.fn() }),
  useAutomationInvocations: (_id: string, limit: number) => {
    history.requestedLimits.push(limit);
    return {
      invocations: Array.from({ length: Math.min(limit, history.total) }, (_, i) => ({
        id: `inv-${i}`,
      })),
      total: history.total,
      loading: false,
      mutate: vi.fn(),
    };
  },
}));
vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    authorization: {
      userId: CURRENT_USER_ID,
      permissions,
    },
  }),
}));
vi.mock("@/components/automations/run-history", () => ({
  RunHistory: ({ hasMore, onLoadMore }: { hasMore: boolean; onLoadMore?: () => void }) =>
    hasMore ? <button onClick={onLoadMore}>Load more</button> : null,
}));

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <AutomationDetailPage params={Promise.resolve({ id: "auto-1" })} />
      </Suspense>
    );
  });
}

beforeEach(() => {
  permissions = [];
  search = "";
  push.mockReset();
  vi.mocked(browserApiFetch).mockReset();
  vi.mocked(browserApiFetch).mockResolvedValue(Response.json({}));
  automation.capabilities = undefined;
  history.total = 0;
  history.requestedLimits = [];
});
afterEach(cleanup);

describe("AutomationDetailPage run history", () => {
  it("stops offering more history at the largest page the endpoint serves", async () => {
    history.total = MAX_AUTOMATION_INVOCATION_LIST_LIMIT + 50;
    await renderPage();
    await screen.findByRole("heading", { name: "Nightly review" });

    for (let click = 0; click < 10; click += 1) {
      const loadMore = screen.queryByRole("button", { name: "Load more" });
      if (!loadMore) break;
      await act(async () => {
        fireEvent.click(loadMore);
      });
    }

    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(Math.max(...history.requestedLimits)).toBe(MAX_AUTOMATION_INVOCATION_LIST_LIMIT);
    expect(history.requestedLimits.at(-1)).toBe(MAX_AUTOMATION_INVOCATION_LIST_LIMIT);
  });
});

describe("AutomationDetailPage authorization", () => {
  it.each([undefined, "team/one"])(
    "preserves scope %s on back, edit, and delete",
    async (teamId) => {
      search = teamId ? new URLSearchParams({ teamId }).toString() : "";
      const query = teamId ? "?teamId=team%2Fone" : "";
      automation.capabilities = { canRead: true, canManage: true, canTrigger: true };
      await renderPage();
      expect(screen.getByRole("link", { name: "Back to automations" })).toHaveAttribute(
        "href",
        `/automations${query}`
      );
      expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
        "href",
        `/automations/auto-1/edit${query}`
      );
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));
      await waitFor(() => expect(push).toHaveBeenCalledWith(`/automations${query}`));
    }
  );

  it("reports a failed delete without leaving its scope", async () => {
    automation.capabilities = { canRead: true, canManage: true, canTrigger: false };
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({}, { status: 403 }));
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to delete automation");
    expect(push).not.toHaveBeenCalled();
  });

  it("does not infer resource capabilities from global permissions", async () => {
    permissions = ["automations.manage.any", "automations.trigger.any"];
    await renderPage();
    await screen.findByRole("heading", { name: "Nightly review" });

    expect(screen.queryByRole("link", { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trigger Now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("shows manage and trigger controls using response capabilities", async () => {
    automation.capabilities = { canRead: true, canManage: true, canTrigger: true };
    await renderPage();
    await screen.findByRole("heading", { name: "Nightly review" });

    expect(screen.getByRole("link", { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trigger Now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});
