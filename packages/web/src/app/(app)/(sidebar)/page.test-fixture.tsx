import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  type KeyboardShortcutPreferences,
} from "@open-inspect/shared/types/keyboard-shortcuts";
import type { TeamResponse } from "@/hooks/use-teams";
import type { TeamRole } from "@open-inspect/shared/types/teams";

expect.extend(matchers);

const mocks = vi.hoisted(() => {
  const teamContext: {
    activeTeamId: string | null;
    teams: (TeamResponse & { role: TeamRole })[];
    teamsLoading: boolean;
    teamsError: unknown;
    requireTeamOnCreate: boolean;
  } = {
    activeTeamId: null,
    teams: [],
    teamsLoading: false,
    teamsError: undefined,
    requireTeamOnCreate: false,
  };
  return {
    routerPush: vi.fn(),
    toastError: vi.fn(),
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
      provider: "openai" | "xai" | "anthropic";
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
    ...teamContext,
    setActiveTeam: vi.fn(),
  };
});

export { mocks };

export const repo = {
  id: 1,
  fullName: "open-inspect/background-agents",
  owner: "open-inspect",
  name: "background-agents",
  description: null,
  private: true,
  defaultBranch: "main",
};

export const environment = {
  id: "env-1",
  name: "full-stack",
  description: null,
  prebuildEnabled: false,
  createdAt: 1,
  updatedAt: 1,
  repositories: [{ repoOwner: "acme", repoName: "backend", repoId: 1, baseBranch: "main" }],
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

vi.mock("@/hooks/use-active-team", () => ({
  useActiveTeam: () => ({
    activeTeamId: mocks.activeTeamId,
    setActiveTeam: mocks.setActiveTeam,
    teams: mocks.teams,
    scope: undefined,
    requireTeamOnCreate: mocks.requireTeamOnCreate,
    loading: mocks.teamsLoading,
    error: mocks.teamsError,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

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
  ModelReasoningSelector: ({
    disabled,
    harness,
    onHarnessChange,
    onModelChange,
  }: {
    disabled?: boolean;
    harness?: string | null;
    onHarnessChange?: (harness: "opencode" | "claude") => void;
    onModelChange: (model: string) => void;
  }) => (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-label={harness ? `Agent, model and effort: ${harness}` : "Model and effort"}
        data-agent-editable={onHarnessChange ? "true" : "false"}
      >
        Model and effort
      </button>
      <button type="button" onClick={() => onModelChange("openai/gpt-5.4")}>
        Switch model to GPT-5.4
      </button>
      {onHarnessChange && (
        <>
          <button type="button" onClick={() => onHarnessChange("claude")}>
            Switch agent to claude
          </button>
          <button type="button" onClick={() => onHarnessChange("opencode")}>
            Switch agent to opencode
          </button>
        </>
      )}
    </>
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
  mocks.activeTeamId = null;
  mocks.teams = [];
  mocks.teamsLoading = false;
  mocks.teamsError = undefined;
  mocks.requireTeamOnCreate = false;
  mocks.setActiveTeam.mockReset();
  mocks.routerPush.mockReset();
  mocks.toastError.mockReset();
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
      if (url === "/api/sessions/session-1/archive") {
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

export function sessionCreateBody(): Record<string, unknown> {
  const calls = vi.mocked(globalThis.fetch).mock.calls;
  const createCall = calls.find(([input]) => String(input) === "/api/sessions");
  expect(createCall).toBeDefined();
  return JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
}
