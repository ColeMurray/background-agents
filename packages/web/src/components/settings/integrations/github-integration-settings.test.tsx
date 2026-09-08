// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import {
  GITHUB_AUTOFIX_DEFAULTS,
  type GitHubBotSettings,
  type GitHubGlobalConfig,
} from "@open-inspect/shared/types/integrations";
import { GitHubIntegrationSettings } from "./github-integration-settings";

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => true }),
}));

expect.extend(matchers);

interface RepoSettingsEntry {
  repo: string;
  settings: GitHubBotSettings;
}

const { useSWRMock, mutateMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn(),
  mutateMock: vi.fn(),
}));

vi.mock("swr", () => ({
  default: useSWRMock,
  mutate: mutateMock,
}));

vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: () => ({
    enabledModelOptions: [
      {
        category: "Anthropic",
        models: [{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
      },
    ],
  }),
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
  global?: GitHubGlobalConfig | null;
  repos?: RepoSettingsEntry[];
  availableRepos?: EnrichedRepository[];
  globalLoading?: boolean;
  reposLoading?: boolean;
}) {
  useSWRMock.mockImplementation((key: string) => {
    if (key === "/api/integration-settings/github") {
      return {
        data: opts.global === undefined ? undefined : { settings: opts.global },
        isLoading: opts.globalLoading ?? false,
      };
    }
    if (key === "/api/integration-settings/github/repos") {
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
    return { data: undefined, isLoading: false };
  });
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

function okJson(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

function repoOverrideRow(fullName: string) {
  return screen.getByText(fullName).closest("div")!.parentElement!;
}

function autoReviewControls(row: HTMLElement) {
  return within(row).getByText("Auto-review new PRs").parentElement!;
}

async function selectAutoReviewMode(row: HTMLElement, option: RegExp) {
  const user = userEvent.setup();
  await user.click(within(autoReviewControls(row)).getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: option }));
}

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

describe("GitHubIntegrationSettings", () => {
  it("starts integration content at heading level two", () => {
    setupSWR({ global: null });

    render(<GitHubIntegrationSettings />);

    expect(screen.getByRole("heading", { name: "GitHub Bot", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connection", level: 3 })).toBeInTheDocument();
  });

  it("renders the default-off Autofix block and persists one complete global policy", async () => {
    const user = userEvent.setup();
    setupSWR({ global: { defaults: { autoReviewOnOpen: true } } });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    expect(screen.getByRole("switch", { name: "Enable Autofix" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
    expect(screen.getByRole("switch", { name: "Submitted reviews" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(
      screen.getByText(/reviews from the configured Open Inspect App, regardless of workflow/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Enable Autofix" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: {
              autoReviewOnOpen: true,
              autofix: {
                enabled: true,
                reviewsEnabled: true,
                prCommentsEnabled: true,
                openInspectReviewsEnabled: true,
                allowedReviewBots: [],
                maxAttemptsPerPrPer24Hours: 30,
              },
            },
          },
        }),
      })
    );
  });

  it("accepts more than one exact review-bot username", async () => {
    const user = userEvent.setup();
    setupSWR({ global: { defaults: { autoReviewOnOpen: true } } });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    const input = screen.getByRole("textbox", { name: "Exact third-party review bots" });
    fireEvent.change(input, { target: { value: "coderabbitai[bot], renovate[bot]" } });
    expect(input).toHaveValue("coderabbitai[bot], renovate[bot]");
    expect(screen.getByText(/bot-authored feedback is untrusted input/i)).toBeInTheDocument();

    const attemptLimit = screen.getByRole("spinbutton", {
      name: "Attempts per PR per 24 hours",
    });
    await user.clear(attemptLimit);
    expect(attemptLimit).toHaveValue(null);
    await user.type(attemptLimit, "75");
    expect(attemptLimit).toHaveValue(75);
    expect(
      screen.getByText(/higher or unlimited attempts increase autonomous work/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        body: expect.stringContaining(
          '"allowedReviewBots":["coderabbitai[bot]","renovate[bot]"],"maxAttemptsPerPrPer24Hours":75'
        ),
      })
    );
  });

  it("persists an explicit unlimited Autofix attempt policy", async () => {
    const user = userEvent.setup();
    setupSWR({ global: { defaults: { autoReviewOnOpen: true } } });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    await user.click(screen.getByRole("checkbox", { name: "No Autofix attempt limit" }));
    expect(screen.getByRole("spinbutton", { name: "Attempts per PR per 24 hours" })).toBeDisabled();
    expect(screen.getByText(/unlimited attempts increase autonomous work/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        body: expect.stringContaining('"maxAttemptsPerPrPer24Hours":null'),
      })
    );
  });

  it("renders and preserves global model and reasoning defaults", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          autoReviewOnOpen: true,
          model: "anthropic/claude-sonnet-4-6",
          reasoningEffort: "high",
          autofix: { enabled: true, reviewsEnabled: false },
        },
      },
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    expect(screen.getByText("Default model")).toBeInTheDocument();
    expect(screen.getByText("Default reasoning effort")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Default model" })).toHaveTextContent(
      "Claude Sonnet 4.6"
    );
    expect(screen.getByRole("combobox", { name: "Default reasoning effort" })).toHaveTextContent(
      "high"
    );

    await user.click(screen.getByRole("switch", { name: /auto-review new prs/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: {
              autoReviewOnOpen: false,
              model: "anthropic/claude-sonnet-4-6",
              reasoningEffort: "high",
              autofix: {
                ...GITHUB_AUTOFIX_DEFAULTS,
                enabled: true,
                reviewsEnabled: false,
              },
            },
          },
        }),
      })
    );
  });

  it("clears global model defaults without resetting unrelated settings", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          autoReviewOnOpen: false,
          model: "anthropic/claude-sonnet-4-6",
          reasoningEffort: "high",
          codeReviewInstructions: "Focus on security.",
        },
      },
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    await user.click(screen.getByRole("combobox", { name: "Default reasoning effort" }));
    await user.click(await screen.findByRole("option", { name: "Use model default" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: {
              autoReviewOnOpen: false,
              model: "anthropic/claude-sonnet-4-6",
              codeReviewInstructions: "Focus on security.",
            },
          },
        }),
      })
    );

    await user.click(screen.getByRole("combobox", { name: "Default model" }));
    await user.click(await screen.findByRole("option", { name: "Use system default" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: {
              autoReviewOnOpen: false,
              codeReviewInstructions: "Focus on security.",
            },
          },
        }),
      })
    );
  });

  it("preserves sparse Autofix overrides when saving an unrelated repo setting", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          autoReviewOnOpen: false,
          autofix: { maxAttemptsPerPrPer24Hours: null },
        },
      },
      repos: [{ repo: "acme/web", settings: { autofix: { enabled: true } } }],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    const row = repoOverrideRow("acme/web");
    await selectAutoReviewMode(row, /override for this repo/i);

    expect(within(autoReviewControls(row)).getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false"
    );

    await user.click(within(row).getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github/repos/acme/web",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            autoReviewOnOpen: false,
            autofix: { enabled: true },
          },
        }),
      })
    );
  });

  it.each([false, true])(
    "repo auto-review override value %s renders and persists after mode changes",
    async (autoReviewOnOpen) => {
      const user = userEvent.setup();
      setupSWR({
        global: { defaults: { autoReviewOnOpen: !autoReviewOnOpen } },
        repos: [{ repo: "acme/web", settings: { autoReviewOnOpen } }],
        availableRepos: [repo("acme/web")],
      });
      fetchMock.mockResolvedValue(okJson({}));

      render(<GitHubIntegrationSettings />);

      const row = repoOverrideRow("acme/web");
      expect(
        within(autoReviewControls(row)).getByText(autoReviewOnOpen ? "Enabled" : "Disabled")
      ).toBeInTheDocument();
      expect(within(autoReviewControls(row)).getByRole("switch")).toHaveAttribute(
        "aria-checked",
        String(autoReviewOnOpen)
      );

      await selectAutoReviewMode(row, /use global default/i);
      await selectAutoReviewMode(row, /override for this repo/i);
      await user.click(within(row).getByRole("button", { name: /^save$/i }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integration-settings/github/repos/acme/web",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ settings: { autoReviewOnOpen } }),
        })
      );
    }
  );
});
