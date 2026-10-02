// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ProjectView } from "@/hooks/use-projects";
import { ProjectAutomations } from "./project-automations";
expect.extend(matchers);
afterEach(cleanup);
const mocks = vi.hoisted(() => ({
  pages: 1,
  loadMore: vi.fn(),
  write: vi.fn(),
  mutate: vi.fn(),
  scope: vi.fn(),
}));
vi.mock("@/hooks/use-projects", () => ({ useProjectMutations: () => mocks.write }));
vi.mock("@/hooks/use-automations", () => ({
  useAutomations: (...args: unknown[]) => {
    mocks.scope(...args);
    return {
      automations:
        mocks.pages === 1
          ? []
          : [
              {
                id: "older-subscribed",
                name: "Older subscribed",
                projectId: "project",
                ownerTeamId: null,
                capabilities: { canManage: true },
              },
              {
                id: "older-candidate",
                name: "Older candidate",
                projectId: null,
                ownerTeamId: null,
                capabilities: { canManage: true },
              },
              {
                id: "other-team",
                name: "Other team",
                projectId: null,
                ownerTeamId: "team",
                capabilities: { canManage: true },
              },
              {
                id: "read-only",
                name: "Read only candidate",
                projectId: null,
                ownerTeamId: null,
                capabilities: { canManage: false },
              },
              {
                id: "read-only-subscribed",
                name: "Read only subscribed",
                projectId: "project",
                ownerTeamId: null,
                capabilities: { canManage: false },
              },
            ],
      error: undefined,
      mutate: mocks.mutate,
      loading: false,
      loadingMore: false,
      hasMore: mocks.pages === 1,
      loadMore: mocks.loadMore,
    };
  },
}));
it("makes older subscriptions and candidates reachable through pagination", () => {
  mocks.pages = 1;
  mocks.loadMore.mockImplementation(() => {
    mocks.pages = 2;
  });
  const project = {
    id: "project",
    ownerTeamId: null,
    capabilities: { canSubscribeAutomations: true },
  } as ProjectView;
  const view = render(<ProjectAutomations project={project} />);
  fireEvent.click(screen.getByRole("button", { name: "Load more automations" }));
  view.rerender(<ProjectAutomations project={project} />);
  expect(screen.getByRole("link", { name: "Older subscribed" })).toHaveAttribute(
    "href",
    "/automations/older-subscribed"
  );
  expect(mocks.scope).toHaveBeenLastCalledWith("", "null");
  expect(screen.queryByRole("option", { name: "Other team" })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Read only candidate" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Read only subscribed" })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Unsubscribe" })).toHaveLength(1);
  fireEvent.change(screen.getByRole("combobox", { name: "Subscribe automation" }), {
    target: { value: "older-candidate" },
  });
  expect(mocks.write).toHaveBeenCalledWith("/api/automations/older-candidate", "PUT", {
    projectId: "project",
  });
  expect(screen.queryByRole("button", { name: "Load more automations" })).not.toBeInTheDocument();
});
