// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { DEFAULT_MODEL } from "@open-inspect/shared";
import Home from "./page";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  mutateMock: vi.fn(),
  reposValue: [] as Array<{
    id: number;
    fullName: string;
    owner: string;
    name: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
  }>,
  loadingReposValue: false,
}));

const repo = {
  id: 1,
  fullName: "open-inspect/background-agents",
  owner: "open-inspect",
  name: "background-agents",
  description: null,
  private: true,
  defaultBranch: "main",
};

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } }, status: "authenticated" }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock("swr", () => ({
  mutate: mocks.mutateMock,
}));

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: () => ({ isOpen: true, toggle: vi.fn() }),
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: mocks.reposValue, loading: mocks.loadingReposValue }),
}));

vi.mock("@/hooks/use-branches", () => ({
  useBranches: () => ({ branches: [{ name: "main" }], loading: false }),
}));

vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: () => ({
    enabledModels: [DEFAULT_MODEL],
    enabledModelOptions: [
      {
        category: "Anthropic",
        models: [{ id: DEFAULT_MODEL, name: "Claude Sonnet 4.6", description: "" }],
      },
    ],
    loading: false,
  }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  mocks.reposValue = [repo];
  mocks.loadingReposValue = false;
  mocks.routerPush.mockReset();
  mocks.mutateMock.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/sessions") {
        return Response.json({ sessionId: "session-1" });
      }
      if (url === "/api/sessions/session-1/prompt") {
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    })
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function sessionCreateBody(): Record<string, unknown> {
  const calls = vi.mocked(fetch).mock.calls;
  const createCall = calls.find(([input]) => String(input) === "/api/sessions");
  expect(createCall).toBeDefined();
  return JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
}

describe("Home", () => {
  it("can start a new session without a repository from the primary selector", async () => {
    const user = userEvent.setup();
    render(<Home />);

    await screen.findByRole("button", { name: /background-agents/i });
    await user.click(screen.getByRole("button", { name: /background-agents/i }));
    const listbox = screen.getByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: /no repository/i }));

    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Investigate logs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
    expect(sessionCreateBody()).toMatchObject({
      repoOwner: null,
      repoName: null,
      model: DEFAULT_MODEL,
    });
    expect(sessionCreateBody()).not.toHaveProperty("branch");
  });

  it("defaults to a no-repository session target when no repositories are available", async () => {
    mocks.reposValue = [];
    const user = userEvent.setup();
    render(<Home />);

    await screen.findByRole("button", { name: /no repository/i });
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Draft a plan");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
    expect(sessionCreateBody()).toMatchObject({
      repoOwner: null,
      repoName: null,
      model: DEFAULT_MODEL,
    });
    expect(screen.getByText(/you can start without a repository/i)).toBeInTheDocument();
  });
});
