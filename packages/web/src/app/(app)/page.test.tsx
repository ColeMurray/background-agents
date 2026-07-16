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
  environmentsLoadingValue: false,
  environmentsValue: [] as Array<{
    id: string;
    name: string;
    description: string | null;
    prebuildEnabled: boolean;
    createdAt: number;
    updatedAt: number;
    repositories: Array<{
      repoOwner: string;
      repoName: string;
      repoId: number | null;
      baseBranch: string;
    }>;
  }>,
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
  // Home uses the default export only for the picker's prebuild-status text.
  default: () => ({ data: undefined, isLoading: false }),
  mutate: mocks.mutateMock,
}));

vi.mock("@/hooks/use-environments", () => ({
  ENVIRONMENTS_KEY: "/api/environments",
  useEnvironments: () => ({
    environments: mocks.environmentsValue,
    loading: mocks.environmentsLoadingValue,
  }),
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
  mocks.environmentsLoadingValue = false;
  mocks.environmentsValue = [];
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
  it("keeps the attachment control anchored while the sandbox warms", async () => {
    let resolveCreate: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation(
      (input) =>
        new Promise<Response>((resolve) => {
          if (String(input) === "/api/sessions") {
            resolveCreate = resolve;
          } else {
            resolve(Response.json({ error: "unexpected request" }, { status: 500 }));
          }
        })
    );
    const user = userEvent.setup();
    render(<Home />);

    await user.type(screen.getByPlaceholderText("What do you want to build?"), "I");

    const warmingStatus = await screen.findByText("Warming sandbox...");
    const attachmentButton = screen.getByRole("button", { name: "Attach images" });
    expect(
      warmingStatus.compareDocumentPosition(attachmentButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    resolveCreate?.(Response.json({ sessionId: "session-1" }));
    await waitFor(() => expect(screen.queryByText("Warming sandbox...")).not.toBeInTheDocument());
  });

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

  it("launches from an environment sending only environmentId", async () => {
    mocks.environmentsValue = [
      {
        id: "env-1",
        name: "full-stack",
        description: null,
        prebuildEnabled: true,
        createdAt: 1,
        updatedAt: 1,
        repositories: [
          { repoOwner: "acme", repoName: "backend", repoId: 1, baseBranch: "main" },
          { repoOwner: "acme", repoName: "frontend", repoId: 2, baseBranch: "main" },
        ],
      },
    ];
    const user = userEvent.setup();
    render(<Home />);

    await screen.findByRole("button", { name: /background-agents/i });
    await user.click(screen.getByRole("button", { name: /background-agents/i }));
    const listbox = screen.getByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: /full-stack/i }));

    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Wire the API");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
    const body = sessionCreateBody();
    expect(body).toMatchObject({ environmentId: "env-1", model: DEFAULT_MODEL });
    expect(body).not.toHaveProperty("repoOwner");
    expect(body).not.toHaveProperty("repositories");
    expect(body).not.toHaveProperty("branch");
  });

  it("launches an ad-hoc set sending only repositories, seeded from the selected repo", async () => {
    mocks.reposValue = [
      repo,
      {
        id: 2,
        fullName: "open-inspect/docs",
        owner: "open-inspect",
        name: "docs",
        description: null,
        private: false,
        defaultBranch: "main",
      },
    ];
    const user = userEvent.setup();
    render(<Home />);

    await screen.findByRole("button", { name: /background-agents/i });
    await user.click(screen.getByRole("button", { name: /background-agents/i }));
    const listbox = screen.getByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: /multiple repositories/i }));

    // The multi-select opens seeded with the previously selected repo; add docs.
    await user.click(screen.getByRole("button", { name: /repository selection/i }));
    await user.click(screen.getByRole("checkbox", { name: /open-inspect\/docs/i }));
    await user.click(screen.getByRole("button", { name: /done/i }));

    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Sync the docs");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
    const body = sessionCreateBody();
    expect(body).toMatchObject({
      repositories: [
        { repoOwner: "open-inspect", repoName: "background-agents" },
        { repoOwner: "open-inspect", repoName: "docs" },
      ],
    });
    expect(body).not.toHaveProperty("repoOwner");
    expect(body).not.toHaveProperty("environmentId");
    expect(body).not.toHaveProperty("branch");
  });

  const environment = {
    id: "env-1",
    name: "full-stack",
    description: null,
    prebuildEnabled: false,
    createdAt: 1,
    updatedAt: 1,
    repositories: [{ repoOwner: "acme", repoName: "backend", repoId: 1, baseBranch: "main" }],
  };

  it("persists an environment selection and restores it on the next visit", async () => {
    mocks.environmentsValue = [environment];
    const user = userEvent.setup();
    const first = render(<Home />);

    await screen.findByRole("button", { name: /background-agents/i });
    await user.click(screen.getByRole("button", { name: /background-agents/i }));
    await user.click(
      within(screen.getByRole("listbox")).getByRole("option", { name: /full-stack/i })
    );

    expect(localStorage.getItem("open-inspect-last-selected-repo")).toBe("env:env-1");

    // A fresh mount (e.g. the sidebar "+" navigating back to "/") restores it.
    first.unmount();
    render(<Home />);
    await screen.findByRole("button", { name: /full-stack/i });

    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Continue work");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
    expect(sessionCreateBody()).toMatchObject({ environmentId: "env-1" });
  });

  it("waits for environments to load before restoring a stored environment", async () => {
    localStorage.setItem("open-inspect-last-selected-repo", "env:env-1");
    mocks.environmentsLoadingValue = true;
    const { rerender } = render(<Home />);

    // Must not commit the repo default while the stored environment is pending.
    await screen.findByRole("button", { name: /select repo/i });
    expect(screen.queryByRole("button", { name: /background-agents/i })).not.toBeInTheDocument();

    mocks.environmentsLoadingValue = false;
    mocks.environmentsValue = [environment];
    rerender(<Home />);
    await screen.findByRole("button", { name: /full-stack/i });
  });

  it("falls back to the repo default when the stored environment was deleted", async () => {
    localStorage.setItem("open-inspect-last-selected-repo", "env:deleted-env");
    render(<Home />);

    await screen.findByRole("button", { name: /background-agents/i });
  });

  it("falls back to the repo default on a malformed stored value", async () => {
    localStorage.setItem("open-inspect-last-selected-repo", "env:");
    render(<Home />);

    await screen.findByRole("button", { name: /background-agents/i });
  });

  it("still restores a stored repository fullName (legacy value)", async () => {
    mocks.reposValue = [
      repo,
      {
        id: 2,
        fullName: "open-inspect/docs",
        owner: "open-inspect",
        name: "docs",
        description: null,
        private: false,
        defaultBranch: "main",
      },
    ];
    localStorage.setItem("open-inspect-last-selected-repo", "open-inspect/docs");
    render(<Home />);

    await screen.findByRole("button", { name: /docs/i });
  });
});
