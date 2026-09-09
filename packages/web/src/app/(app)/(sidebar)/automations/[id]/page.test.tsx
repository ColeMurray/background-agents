// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_AUTOMATION_INVOCATION_LIST_LIMIT } from "@open-inspect/shared/types/automations";
import AutomationDetailPage from "./page";

expect.extend(matchers);

const CURRENT_USER_ID = "11111111111111111111111111111111";
const OTHER_USER_ID = "22222222222222222222222222222222";
let permissions: string[] = [];
/** How many invocations the automation has, and every limit the page asked for. */
const history = vi.hoisted(() => ({ total: 0, requestedLimits: [] as number[] }));

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
  userId: OTHER_USER_ID,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  eventType: null,
  triggerConfig: null,
  repositories: [],
  environmentIds: [],
  providerSelections: {},
};

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}));
vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => null,
  useSidebarContext: () => ({ isOpen: true }),
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
  it("does not treat createdBy provenance as canonical ownership", async () => {
    permissions = ["automations.manage.own", "automations.trigger.own"];
    await renderPage();
    await screen.findByRole("heading", { name: "Nightly review" });

    expect(screen.queryByRole("link", { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trigger Now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("shows manage and trigger controls with any-scoped capabilities", async () => {
    permissions = ["automations.manage.any", "automations.trigger.any"];
    await renderPage();
    await screen.findByRole("heading", { name: "Nightly review" });

    expect(screen.getByRole("link", { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trigger Now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});
