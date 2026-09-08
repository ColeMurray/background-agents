// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { MAX_SLACK_ROUTING_RULES } from "@open-inspect/shared";
import type {
  Environment,
  SlackGlobalConfig,
  SlackRepoSettings,
  EnrichedRepository,
} from "@open-inspect/shared";
import { SlackIntegrationSettings } from "./slack-integration-settings";

expect.extend(matchers);

interface RepoSettingsEntry {
  repo: string;
  settings: SlackRepoSettings;
}

const { useSWRMock, mutateMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn(),
  mutateMock: vi.fn(),
}));

vi.mock("swr", () => ({
  default: useSWRMock,
  mutate: mutateMock,
}));

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

const fetchMock = vi.fn();

function setupSWR(opts: {
  global?: SlackGlobalConfig | null;
  repos?: RepoSettingsEntry[];
  availableRepos?: EnrichedRepository[];
  environments?: Environment[];
  globalLoading?: boolean;
  reposLoading?: boolean;
  environmentsLoading?: boolean;
}) {
  useSWRMock.mockImplementation((key: string) => {
    if (key === "/api/integration-settings/slack") {
      return {
        data: opts.global === undefined ? undefined : { settings: opts.global },
        isLoading: opts.globalLoading ?? false,
      };
    }
    if (key === "/api/integration-settings/slack/repos") {
      return {
        data: { repos: opts.repos ?? [] },
        isLoading: opts.reposLoading ?? false,
      };
    }
    if (key === "/api/repos") {
      return {
        data: { repos: opts.availableRepos ?? [] },
        isLoading: false,
      };
    }
    if (key === "/api/environments") {
      if (opts.environmentsLoading) {
        return { data: undefined, isLoading: true };
      }
      return {
        data: { environments: opts.environments ?? [], total: opts.environments?.length ?? 0 },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false };
  });
}

function environment(id: string, name: string): Environment {
  return {
    id,
    name,
    description: null,
    prebuildEnabled: false,
    createdAt: 1,
    updatedAt: 1,
    repositories: [{ repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" }],
  };
}

function repo(fullName: string): EnrichedRepository {
  return {
    fullName,
    private: false,
    description: null,
    htmlUrl: `https://github.com/${fullName}`,
    defaultBranch: "main",
  } as unknown as EnrichedRepository;
}

// Radix Select uses pointer-capture APIs that jsdom doesn't implement.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

beforeEach(() => {
  fetchMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  mutateMock.mockReset();
  useSWRMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function okJson(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe("SlackIntegrationSettings", () => {
  it("shows skeleton while loading global settings", () => {
    setupSWR({ globalLoading: true });
    const { container } = render(<SlackIntegrationSettings />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("renders empty state with master switch off and mentions policy 'allow'", () => {
    setupSWR({ global: null });
    render(<SlackIntegrationSettings />);

    expect(screen.getByRole("heading", { name: "Slack" })).toBeInTheDocument();

    const masterSwitch = screen.getByRole("switch", { name: /enable agent notifications/i });
    expect(masterSwitch).toHaveAttribute("aria-checked", "false");

    const allowRadio = screen.getByRole("radio", { name: /allow/i }) as HTMLInputElement;
    expect(allowRadio.checked).toBe(true);
  });

  it("describes channel access via Slack bot membership in help copy", () => {
    setupSWR({ global: null });
    render(<SlackIntegrationSettings />);

    expect(
      screen.getByText(/invite the .*slack.* bot to a channel/i, { selector: "p" })
    ).toBeInTheDocument();
  });

  it("toggling master switch on and saving sends agentNotificationsEnabled: true", async () => {
    const user = userEvent.setup();
    setupSWR({ global: null });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SlackIntegrationSettings />);

    await user.click(screen.getByRole("switch", { name: /enable agent notifications/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/integration-settings/slack");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string) as { settings: SlackGlobalConfig };
    expect(body.settings.defaults).toEqual({
      agentNotificationsEnabled: true,
      mentionsPolicy: "allow",
    });
  });

  it("changing mentions policy radio sends the new value on save", async () => {
    const user = userEvent.setup();
    setupSWR({ global: null });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SlackIntegrationSettings />);

    await user.click(screen.getByRole("radio", { name: /escape/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string) as { settings: SlackGlobalConfig };
    expect(body.settings.defaults?.mentionsPolicy).toBe("escape");
  });

  it("saving a selected default model includes the model in global defaults", async () => {
    const user = userEvent.setup();
    setupSWR({ global: null });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SlackIntegrationSettings />);

    const modelSection = screen.getByText("Default model").closest("div")!;
    await user.click(within(modelSection).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "GPT 5.4" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string) as { settings: SlackGlobalConfig };
    expect(body.settings.defaults?.model).toBe("openai/gpt-5.4");
  });

  it("clearing the selected default model omits model while preserving other defaults", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          agentNotificationsEnabled: true,
          model: "openai/gpt-5.4",
          mentionsPolicy: "strip",
          routingRules: [{ keyword: "frontend", target: "acme/web" }],
        },
      },
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SlackIntegrationSettings />);

    await user.click(screen.getByRole("button", { name: /use system default/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string) as { settings: SlackGlobalConfig };
    expect(body.settings.defaults).toEqual({
      agentNotificationsEnabled: true,
      mentionsPolicy: "strip",
      routingRules: [{ keyword: "frontend", target: "acme/web" }],
    });
  });

  it("renders populated settings with master switch on and policy 'strip'", () => {
    setupSWR({
      global: {
        defaults: {
          agentNotificationsEnabled: true,
          mentionsPolicy: "strip",
        },
      },
    });
    render(<SlackIntegrationSettings />);

    expect(screen.getByRole("switch", { name: /enable agent notifications/i })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect((screen.getByRole("radio", { name: /strip/i }) as HTMLInputElement).checked).toBe(true);
  });

  it("adding a per-repo override posts an empty settings body", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: { defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" } },
      repos: [],
      availableRepos: [repo("group/subgroup/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SlackIntegrationSettings />);

    await user.click(screen.getByRole("combobox", { name: /select a repository/i }));
    await user.click(await screen.findByRole("option", { name: "group/subgroup/web" }));
    await user.click(screen.getByRole("button", { name: /add override/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/slack/repos/group%2Fsubgroup/web",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: {} }),
      })
    );
  });

  it("repo override row toggling enabled flag and saving sends override value", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: { defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" } },
      repos: [{ repo: "acme/web", settings: {} }],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SlackIntegrationSettings />);

    const row = screen.getByText("acme/web").closest("div")!.parentElement!;
    const overrideToggle = within(row).getByRole("combobox");
    await user.click(overrideToggle);
    await user.click(await screen.findByRole("option", { name: /override.*off/i }));
    await user.click(within(row).getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/slack/repos/acme/web",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: { agentNotificationsEnabled: false } }),
      })
    );
  });

  it("removing a per-repo override sends DELETE", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: { defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" } },
      repos: [{ repo: "acme/web", settings: { agentNotificationsEnabled: false } }],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SlackIntegrationSettings />);

    const row = screen.getByText("acme/web").closest("div")!.parentElement!;
    await user.click(within(row).getByRole("button", { name: /remove/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/slack/repos/acme/web",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  // Regression: form must resync when SWR revalidates after the first render.
  it("global form resyncs when settings change from null to populated (not dirty)", () => {
    setupSWR({ global: null });
    const { rerender } = render(<SlackIntegrationSettings />);

    expect(screen.getByRole("switch", { name: /enable agent notifications/i })).toHaveAttribute(
      "aria-checked",
      "false"
    );

    act(() => {
      setupSWR({
        global: { defaults: { agentNotificationsEnabled: true, mentionsPolicy: "strip" } },
      });
    });
    rerender(<SlackIntegrationSettings />);

    expect(screen.getByRole("switch", { name: /enable agent notifications/i })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect((screen.getByRole("radio", { name: /strip/i }) as HTMLInputElement).checked).toBe(true);
  });

  // Regression: dirty edits must not be clobbered by SWR revalidation.
  it("global form preserves dirty local edits when settings revalidate", async () => {
    const user = userEvent.setup();
    setupSWR({ global: null });
    const { rerender } = render(<SlackIntegrationSettings />);

    await user.click(screen.getByRole("switch", { name: /enable agent notifications/i }));
    expect(screen.getByRole("switch", { name: /enable agent notifications/i })).toHaveAttribute(
      "aria-checked",
      "true"
    );

    act(() => {
      setupSWR({
        global: { defaults: { agentNotificationsEnabled: false, mentionsPolicy: "strip" } },
      });
    });
    rerender(<SlackIntegrationSettings />);

    expect(screen.getByRole("switch", { name: /enable agent notifications/i })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect((screen.getByRole("radio", { name: /allow/i }) as HTMLInputElement).checked).toBe(true);
  });

  // Regression: per-repo row must resync when entry.settings changes from SWR.
  it("repo override row resyncs mode when entry.settings updates", () => {
    setupSWR({
      global: { defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" } },
      repos: [{ repo: "acme/web", settings: {} }],
      availableRepos: [repo("acme/web")],
    });
    const { rerender } = render(<SlackIntegrationSettings />);

    expect(screen.getByText("Inherit global setting")).toBeInTheDocument();

    act(() => {
      setupSWR({
        global: { defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" } },
        repos: [{ repo: "acme/web", settings: { agentNotificationsEnabled: false } }],
        availableRepos: [repo("acme/web")],
      });
    });
    rerender(<SlackIntegrationSettings />);

    expect(screen.getByText("Override: notifications off")).toBeInTheDocument();
  });

  // Regression: mixed-case override keys still dedupe against the available-repos picker.
  it("dedupes available repos against mixed-case override keys", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: { defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" } },
      repos: [{ repo: "ACME/Web", settings: {} }],
      availableRepos: [repo("acme/web"), repo("acme/api")],
    });

    render(<SlackIntegrationSettings />);

    await user.click(screen.getByRole("combobox", { name: /select a repository/i }));
    expect(screen.queryByRole("option", { name: "acme/web" })).toBeNull();
    expect(await screen.findByRole("option", { name: "acme/api" })).toBeInTheDocument();
  });

  describe("routing rules", () => {
    function routingSection() {
      return screen.getByRole("heading", { name: /routing rules/i }).closest("section")!;
    }

    it("renders existing routing rules from settings", () => {
      setupSWR({
        global: {
          defaults: {
            agentNotificationsEnabled: false,
            mentionsPolicy: "allow",
            routingRules: [{ keyword: "frontend", target: "acme/web" }],
          },
        },
        availableRepos: [repo("acme/web")],
      });
      render(<SlackIntegrationSettings />);

      const section = routingSection();
      expect(within(section).getByDisplayValue("frontend")).toBeInTheDocument();
      expect(within(section).getByText("acme/web")).toBeInTheDocument();
    });

    it("adds a routing rule and saves it merged into the defaults", async () => {
      const user = userEvent.setup();
      setupSWR({
        global: { defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" } },
        availableRepos: [repo("acme/web")],
      });
      fetchMock.mockResolvedValue(okJson({}));
      render(<SlackIntegrationSettings />);

      const section = routingSection();
      await user.click(within(section).getByRole("button", { name: /add rule/i }));
      await user.type(within(section).getByRole("textbox", { name: /keyword/i }), "Frontend");
      await user.click(within(section).getByRole("combobox", { name: /routing target/i }));
      await user.click(await screen.findByRole("option", { name: "acme/web" }));
      await user.click(within(section).getByRole("button", { name: /save routing rules/i }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integration-settings/slack",
        expect.objectContaining({ method: "PUT" })
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
        settings: SlackGlobalConfig;
      };
      // The UI sends the keyword as-typed (trimmed); the control plane is the
      // sole normalizer that lowercases on write.
      expect(body.settings.defaults).toEqual({
        agentNotificationsEnabled: true,
        mentionsPolicy: "allow",
        routingRules: [{ keyword: "Frontend", target: "acme/web" }],
      });
    });

    it("preserves existing routing rules when the Defaults section is saved", async () => {
      const user = userEvent.setup();
      setupSWR({
        global: {
          defaults: {
            agentNotificationsEnabled: false,
            mentionsPolicy: "allow",
            routingRules: [{ keyword: "frontend", target: "acme/web" }],
          },
        },
        availableRepos: [repo("acme/web")],
      });
      fetchMock.mockResolvedValue(okJson({}));
      render(<SlackIntegrationSettings />);

      await user.click(screen.getByRole("switch", { name: /enable agent notifications/i }));
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
        settings: SlackGlobalConfig;
      };
      expect(body.settings.defaults).toEqual({
        agentNotificationsEnabled: true,
        mentionsPolicy: "allow",
        routingRules: [{ keyword: "frontend", target: "acme/web" }],
      });
    });

    it("omits routingRules on save after the last rule is removed", async () => {
      const user = userEvent.setup();
      setupSWR({
        global: {
          defaults: {
            agentNotificationsEnabled: true,
            mentionsPolicy: "allow",
            routingRules: [{ keyword: "frontend", target: "acme/web" }],
          },
        },
        availableRepos: [repo("acme/web")],
      });
      fetchMock.mockResolvedValue(okJson({}));
      render(<SlackIntegrationSettings />);

      const section = routingSection();
      await user.click(within(section).getByRole("button", { name: /remove/i }));
      await user.click(within(section).getByRole("button", { name: /save routing rules/i }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
        settings: SlackGlobalConfig;
      };
      expect(body.settings.defaults).toEqual({
        agentNotificationsEnabled: true,
        mentionsPolicy: "allow",
      });
    });

    it("blocks save and shows an error when a rule has no target", async () => {
      const user = userEvent.setup();
      setupSWR({
        global: { defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" } },
        availableRepos: [repo("acme/web")],
      });
      render(<SlackIntegrationSettings />);

      const section = routingSection();
      await user.click(within(section).getByRole("button", { name: /add rule/i }));
      await user.type(within(section).getByRole("textbox", { name: /keyword/i }), "frontend");
      await user.click(within(section).getByRole("button", { name: /save routing rules/i }));

      expect(toastError).toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks save and shows an error when more than the maximum rules are defined", async () => {
      const user = userEvent.setup();
      const tooMany = Array.from({ length: MAX_SLACK_ROUTING_RULES + 1 }, (_, i) => ({
        keyword: `rule-${i}`,
        target: "acme/web",
      }));
      setupSWR({
        global: {
          defaults: {
            agentNotificationsEnabled: true,
            mentionsPolicy: "allow",
            routingRules: tooMany,
          },
        },
        availableRepos: [repo("acme/web")],
      });
      render(<SlackIntegrationSettings />);

      const section = routingSection();
      // Save is disabled until the form is dirty; edit a keyword (keeping it
      // valid) so the only remaining problem is the over-limit count.
      await user.type(
        within(section).getAllByRole("textbox", { name: /routing keyword/i })[0],
        "x"
      );
      await user.click(within(section).getByRole("button", { name: /save routing rules/i }));

      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining(String(MAX_SLACK_ROUTING_RULES))
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("warns when a rule targets a repository that is not accessible", () => {
      setupSWR({
        global: {
          defaults: {
            agentNotificationsEnabled: true,
            mentionsPolicy: "allow",
            routingRules: [{ keyword: "frontend", target: "acme/ghost" }],
          },
        },
        availableRepos: [repo("acme/web")],
      });
      render(<SlackIntegrationSettings />);

      const section = routingSection();
      expect(within(section).getByText(/not in your accessible repositories/i)).toBeInTheDocument();
    });

    it("adds an environment-targeted rule and saves it with targetType", async () => {
      const user = userEvent.setup();
      setupSWR({
        global: { defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" } },
        availableRepos: [repo("acme/web")],
        environments: [environment("env_abc123", "full-stack")],
      });
      fetchMock.mockResolvedValue(okJson({}));
      render(<SlackIntegrationSettings />);

      const section = routingSection();
      await user.click(within(section).getByRole("button", { name: /add rule/i }));
      await user.type(within(section).getByRole("textbox", { name: /keyword/i }), "fullstack");
      await user.click(within(section).getByRole("combobox", { name: /routing target/i }));
      await user.click(await screen.findByRole("option", { name: "full-stack" }));
      await user.click(within(section).getByRole("button", { name: /save routing rules/i }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
        settings: SlackGlobalConfig;
      };
      expect(body.settings.defaults?.routingRules).toEqual([
        { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
      ]);
    });

    it("renders a stored environment rule showing the environment name", () => {
      setupSWR({
        global: {
          defaults: {
            agentNotificationsEnabled: true,
            mentionsPolicy: "allow",
            routingRules: [
              { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
            ],
          },
        },
        availableRepos: [repo("acme/web")],
        environments: [environment("env_abc123", "full-stack")],
      });
      render(<SlackIntegrationSettings />);

      const section = routingSection();
      expect(within(section).getByText("full-stack")).toBeInTheDocument();
      expect(within(section).queryByText(/no longer exists/i)).not.toBeInTheDocument();
    });

    it("does not warn about a stored environment rule while environments are loading", () => {
      setupSWR({
        global: {
          defaults: {
            agentNotificationsEnabled: true,
            mentionsPolicy: "allow",
            routingRules: [
              { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
            ],
          },
        },
        availableRepos: [repo("acme/web")],
        environmentsLoading: true,
      });
      render(<SlackIntegrationSettings />);

      const section = routingSection();
      expect(within(section).queryByText(/no longer exists/i)).not.toBeInTheDocument();
    });

    it("warns when a rule targets an environment that no longer exists", () => {
      setupSWR({
        global: {
          defaults: {
            agentNotificationsEnabled: true,
            mentionsPolicy: "allow",
            routingRules: [
              { keyword: "fullstack", target: "env_deleted", targetType: "environment" },
            ],
          },
        },
        availableRepos: [repo("acme/web")],
        environments: [environment("env_abc123", "full-stack")],
      });
      render(<SlackIntegrationSettings />);

      const section = routingSection();
      expect(within(section).getByText(/environment no longer exists/i)).toBeInTheDocument();
    });

    it("warns when the same keyword is used by more than one rule", () => {
      setupSWR({
        global: {
          defaults: {
            agentNotificationsEnabled: true,
            mentionsPolicy: "allow",
            routingRules: [
              { keyword: "frontend", target: "acme/web" },
              { keyword: "frontend", target: "acme/api" },
            ],
          },
        },
        availableRepos: [repo("acme/web"), repo("acme/api")],
      });
      render(<SlackIntegrationSettings />);

      const section = routingSection();
      // Both conflicting rows are flagged.
      expect(within(section).getAllByText(/used by more than one rule/i)).toHaveLength(2);
    });
  });
});
