// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  type KeyboardShortcutPreferences,
} from "@open-inspect/shared/types/keyboard-shortcuts";
import Home from "./page";
import { isSessionInboxKey } from "@/lib/session-inbox-api";
import { isUnarchivedSessionListKey } from "@/lib/session-list";

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
  enabledModelsValue: [] as string[],
  enabledModelOptionsValue: [] as Array<{
    category: string;
    models: Array<{ id: string; name: string; description: string }>;
  }>,
  providerAccountsValue: [] as Array<{
    id: string;
    provider: "openai" | "xai";
    displayName: string;
    externalAccountId: string | null;
    status: "active";
    createdBy: null;
    updatedBy: null;
    lastVerifiedAt: null;
    lastUsedAt: null;
    createdAt: number;
    updatedAt: number;
    archivedAt: null;
  }>,
  providerAccountsLoadingValue: false,
  skillPreview: {
    skills: [
      {
        skillId: "skill-1",
        revisionId: "revision-1",
        name: "review-pr",
        description: "Review a pull request",
        revisionNumber: 1,
        revisionSha256: "abc",
        totalBytes: 10,
        assignmentSources: [],
      },
    ],
    totalBytes: 10,
    ignoredProfileSkillIds: [],
  },
  keyboardShortcuts: null as unknown as KeyboardShortcutPreferences,
  canCreateSession: true,
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

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user-1" } }, status: "authenticated" }),
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      permission === "sessions.create" && mocks.canCreateSession,
  }),
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

vi.mock("@/components/model-reasoning-selector", () => ({
  ModelReasoningSelector: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" disabled={disabled} aria-label="Model and effort">
      Model and effort
    </button>
  ),
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: mocks.reposValue, loading: mocks.loadingReposValue }),
}));

vi.mock("@/hooks/use-branches", () => ({
  useBranches: () => ({ branches: [{ name: "main" }], loading: false }),
}));

vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: () => ({
    enabledModels: mocks.enabledModelsValue,
    enabledModelOptions: mocks.enabledModelOptionsValue,
    loading: false,
  }),
}));

vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: () => ({
    shortcuts: mocks.keyboardShortcuts,
    labels: {
      "send-prompt":
        mocks.keyboardShortcuts["send-prompt"].code === "KeyJ" ? "Alt+J" : "Cmd/Ctrl+Enter",
      "open-command-menu": "Cmd/Ctrl+K",
      "new-session": "Cmd/Ctrl+Shift+O",
      "toggle-sidebar": "Cmd/Ctrl+/",
    },
  }),
}));

vi.mock("@/hooks/use-provider-accounts", () => ({
  useProviderAccounts: () => ({
    providers: [],
    accounts: mocks.providerAccountsValue,
    defaults: [],
    loading: mocks.providerAccountsLoadingValue,
    error: undefined,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-managed-skills", () => ({
  useSkillProfiles: () => ({ profiles: [], loading: false }),
  useSkillResolutionPreview: () => ({
    preview: mocks.skillPreview,
    loading: false,
    error: undefined,
    suggestions: { status: "ready", skills: mocks.skillPreview.skills },
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
  mocks.enabledModelsValue = [DEFAULT_MODEL];
  mocks.enabledModelOptionsValue = [
    {
      category: "Anthropic",
      models: [{ id: DEFAULT_MODEL, name: "Claude Sonnet 4.6", description: "" }],
    },
  ];
  mocks.providerAccountsValue = [];
  mocks.providerAccountsLoadingValue = false;
  mocks.keyboardShortcuts = DEFAULT_KEYBOARD_SHORTCUTS;
  mocks.canCreateSession = true;
  mocks.routerPush.mockReset();
  mocks.mutateMock.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/sessions") {
        return Response.json({ sessionId: "session-1", status: "created" });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sessionCreateBody(): Record<string, unknown> {
  const calls = vi.mocked(fetch).mock.calls;
  const createCall = calls.find(([input]) => String(input) === "/api/sessions");
  expect(createCall).toBeDefined();
  return JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
}

function activeOpenAiAccount(id: string): (typeof mocks.providerAccountsValue)[number] {
  return {
    id,
    provider: "openai",
    displayName: "Team ChatGPT",
    externalAccountId: "acct_public",
    status: "active",
    createdBy: null,
    updatedBy: null,
    lastVerifiedAt: null,
    lastUsedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
}

describe("Home", () => {
  it("does not render session creation UI without session creation permission", () => {
    mocks.canCreateSession = false;

    render(<Home />);

    expect(screen.getByText("You don't have permission to create sessions.")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("What do you want to build?")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send/i })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("focuses the prompt when the page loads", () => {
    render(<Home />);

    expect(screen.getByPlaceholderText("What do you want to build?")).toHaveFocus();
  });

  it("disables autofill suggestions for the prompt", () => {
    render(<Home />);

    expect(screen.getByPlaceholderText("What do you want to build?")).toHaveAttribute(
      "autocomplete",
      "off"
    );
  });

  it("submits with the configured prompt shortcut", async () => {
    mocks.keyboardShortcuts = {
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      "send-prompt": { code: "KeyJ", primary: false, alt: true, shift: false },
    };
    render(<Home />);
    const input = screen.getByPlaceholderText("What do you want to build?");
    fireEvent.change(input, { target: { value: "Ship it" } });
    const promptCalls = () =>
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/prompt")).length;

    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(promptCalls()).toBe(0);
    fireEvent.keyDown(input, { key: "j", code: "KeyJ", altKey: true });
    await waitFor(() => expect(promptCalls()).toBe(1));
  });

  it("completes skills from the current resolution preview", async () => {
    const user = userEvent.setup();
    render(<Home />);
    const input = screen.getByPlaceholderText("What do you want to build?");

    await user.click(input);
    await screen.findByText("(1)");
    await user.type(input, "$rev");
    await user.keyboard("{Enter}");

    expect(input).toHaveValue("$review-pr ");
  });

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

    resolveCreate?.(Response.json({ sessionId: "session-1", status: "created" }));
    await waitFor(() => expect(screen.queryByText("Warming sandbox...")).not.toBeInTheDocument());
  });

  it("does not warm a pending session from a malformed create response", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input) === "/api/sessions") {
        return Response.json({ sessionId: "session-1" });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    });
    const user = userEvent.setup();
    render(<Home />);

    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Investigate logs");
    await waitFor(() => expect(screen.queryByText("Warming sandbox...")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /send/i }));

    await screen.findByText("Failed to create session");
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("invalidates a warmed session when the managed skill selection changes", async () => {
    const user = userEvent.setup();
    render(<Home />);

    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Use no skills");
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/sessions")
      ).toHaveLength(1)
    );

    await user.click(screen.getByRole("button", { name: /all skills/i }));
    await user.click(within(screen.getByRole("listbox")).getByRole("option", { name: /^None/ }));
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
    const createCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input) === "/api/sessions");
    expect(createCalls).toHaveLength(2);
    expect(JSON.parse(String(createCalls[1][1]?.body))).toMatchObject({
      skillSelection: { mode: "none" },
    });
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
    expect(mocks.mutateMock).toHaveBeenCalledWith(isUnarchivedSessionListKey);
    expect(mocks.mutateMock).toHaveBeenCalledWith(isSessionInboxKey);
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

  it("persists provider authentication and restores it on the next visit", async () => {
    const openAiModel = "openai/gpt-5.4";
    const accountId = "a".repeat(32);
    mocks.enabledModelsValue = [DEFAULT_MODEL, openAiModel];
    mocks.enabledModelOptionsValue.push({
      category: "OpenAI",
      models: [{ id: openAiModel, name: "GPT-5.4", description: "" }],
    });
    mocks.providerAccountsValue = [activeOpenAiAccount(accountId)];
    localStorage.setItem("open-inspect-last-selected-model", openAiModel);
    const first = render(<Home />);

    const authenticationTrigger = await screen.findByRole("button", {
      name: /^OpenAI authentication options/,
    });
    const skillTrigger = screen.getByRole("button", { name: /all skills/i });
    expect(
      skillTrigger.compareDocumentPosition(authenticationTrigger) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.pointerDown(authenticationTrigger, { button: 0, ctrlKey: false });
    const authenticationMenu = await screen.findByRole("menuitem", {
      name: "OpenAI authentication",
    });
    authenticationMenu.focus();
    fireEvent.keyDown(authenticationMenu, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Team ChatGPT" }));

    expect(localStorage.getItem("open-inspect-last-provider-selections:v1")).toBe(
      JSON.stringify({ openai: { mode: "provider_account", accountId } })
    );

    first.unmount();
    render(<Home />);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^OpenAI authentication options/ });
    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Continue work");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
    expect(sessionCreateBody()).toMatchObject({
      model: openAiModel,
      providerSelections: { openai: { mode: "provider_account", accountId } },
    });
  });

  it("migrates a valid legacy provider selection", async () => {
    const accountId = "a".repeat(32);
    mocks.providerAccountsValue = [activeOpenAiAccount(accountId)];
    const selection = JSON.stringify({ openai: { mode: "provider_account", accountId } });
    localStorage.setItem("open-inspect-last-provider-selections", selection);
    const user = userEvent.setup();
    render(<Home />);

    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Continue work");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
    expect(sessionCreateBody()).toMatchObject({
      providerSelections: { openai: { mode: "provider_account", accountId } },
    });
    expect(localStorage.getItem("open-inspect-last-provider-selections:v1")).toBe(selection);
    expect(localStorage.getItem("open-inspect-last-provider-selections")).toBeNull();
  });

  it("continues hydrating when legacy provider selection migration fails", async () => {
    const accountId = "a".repeat(32);
    mocks.providerAccountsValue = [activeOpenAiAccount(accountId)];
    const selection = JSON.stringify({ openai: { mode: "provider_account", accountId } });
    localStorage.setItem("open-inspect-last-provider-selections", selection);
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
      if (key === "open-inspect-last-provider-selections:v1") throw new Error("Quota exceeded");
      setItem(key, value);
    });
    const user = userEvent.setup();
    render(<Home />);

    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Continue work");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith("/session/session-1"));
    expect(sessionCreateBody()).toMatchObject({
      providerSelections: { openai: { mode: "provider_account", accountId } },
    });
    expect(localStorage.getItem("open-inspect-last-provider-selections:v1")).toBeNull();
    expect(localStorage.getItem("open-inspect-last-provider-selections")).toBe(selection);
  });

  it("waits for provider accounts and removes a stale stored selection", async () => {
    const staleAccountId = "b".repeat(32);
    localStorage.setItem(
      "open-inspect-last-provider-selections:v1",
      JSON.stringify({ xai: { mode: "provider_account", accountId: staleAccountId } })
    );
    mocks.providerAccountsLoadingValue = true;
    const user = userEvent.setup();
    const view = render(<Home />);

    await user.type(screen.getByPlaceholderText("What do you want to build?"), "Continue work");
    const send = screen.getByRole("button", { name: /send/i });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith("/api/sessions", expect.anything());
    expect(screen.queryByText("Failed to create session")).not.toBeInTheDocument();

    mocks.providerAccountsLoadingValue = false;
    view.rerender(<Home />);
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(sessionCreateBody()).toMatchObject({ providerSelections: {} }));
    expect(localStorage.getItem("open-inspect-last-provider-selections:v1")).toBe("{}");
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

  it("shows the repository and branch above the composer", async () => {
    render(<Home />);

    const repository = await screen.findByRole("button", { name: /background-agents/i });
    const branch = await screen.findByText("main");
    const composer = screen.getByPlaceholderText("What do you want to build?");
    expect(
      repository.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      branch.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(repository.querySelectorAll("svg")).toHaveLength(1);
    expect(branch.closest("button")?.querySelectorAll("svg")).toHaveLength(1);
    expect(branch).toHaveClass("max-w-[9rem]", "truncate");
    expect(screen.queryByText("build agent")).not.toBeInTheDocument();
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
