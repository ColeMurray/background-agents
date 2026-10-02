// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import type {
  LinearBotSettings,
  LinearGlobalConfig,
} from "@open-inspect/shared/types/integrations";
import { LinearIntegrationSettings } from "./linear-integration-settings";

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => true }),
}));

expect.extend(matchers);

interface RepoSettingsEntry {
  repo: string;
  settings: LinearBotSettings;
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
      {
        category: "OpenAI",
        models: [{ id: "openai/gpt-5.4", name: "GPT 5.4" }],
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
  global?: LinearGlobalConfig | null;
  repos?: RepoSettingsEntry[];
  availableRepos?: EnrichedRepository[];
  globalLoading?: boolean;
  reposLoading?: boolean;
}) {
  useSWRMock.mockImplementation((key: string) => {
    if (key === "/api/integration-settings/linear") {
      return {
        data: opts.global === undefined ? undefined : { settings: opts.global },
        isLoading: opts.globalLoading ?? false,
      };
    }
    if (key === "/api/integration-settings/linear/repos") {
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

describe("LinearIntegrationSettings", () => {
  it("saves a global Claude Agent harness choice", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          allowUserPreferenceOverride: true,
          allowLabelModelOverride: true,
          emitToolProgressActivities: true,
        },
      },
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<LinearIntegrationSettings />);

    await user.click(screen.getByRole("combobox", { name: "Agent harness" }));
    await user.click(await screen.findByRole("option", { name: "Claude Agent" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/linear",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: {
              allowUserPreferenceOverride: true,
              allowLabelModelOverride: true,
              emitToolProgressActivities: true,
              harness: "claude",
            },
          },
        }),
      })
    );
  }, 20000);

  it("saves a per-repo Claude Agent harness override", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          allowUserPreferenceOverride: true,
          allowLabelModelOverride: true,
          emitToolProgressActivities: true,
        },
      },
      repos: [{ repo: "acme/web", settings: {} }],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<LinearIntegrationSettings />);

    const row = repoOverrideRow("acme/web");
    await user.click(within(row).getByRole("combobox", { name: "Agent harness" }));
    await user.click(await screen.findByRole("option", { name: "Claude Agent" }));
    await user.click(within(row).getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/linear/repos/acme/web",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            allowUserPreferenceOverride: true,
            allowLabelModelOverride: true,
            emitToolProgressActivities: true,
            harness: "claude",
          },
        }),
      })
    );
  }, 20000);

  it("filters the repo model picker by the inherited global harness", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          allowUserPreferenceOverride: true,
          allowLabelModelOverride: true,
          emitToolProgressActivities: true,
          harness: "claude",
          model: "anthropic/claude-sonnet-4-6",
        },
      },
      repos: [{ repo: "acme/web", settings: {} }],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<LinearIntegrationSettings />);

    const row = repoOverrideRow("acme/web");
    // The row model picker is unlabeled (placeholder only): find its trigger by content.
    const modelTrigger = within(row)
      .getAllByRole("combobox")
      .find((el) => el.textContent?.includes("Default model"));
    expect(modelTrigger).toBeDefined();
    await user.click(modelTrigger!);
    await screen.findByRole("option", { name: "Claude Sonnet 4.6" });
    // Global harness is Claude Agent: GPT models are not offered for this repo.
    expect(screen.queryByRole("option", { name: "GPT 5.4" })).toBeNull();
  }, 20000);

  it("warns on an inherited model the repo harness cannot run, keeping sparse overrides", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          allowUserPreferenceOverride: true,
          allowLabelModelOverride: true,
          emitToolProgressActivities: true,
          model: "openai/gpt-5.4",
        },
      },
      repos: [{ repo: "acme/web", settings: { harness: "claude" } }],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<LinearIntegrationSettings />);

    const row = repoOverrideRow("acme/web");
    expect(within(row).getByText(/cannot run on the Claude Agent harness/)).toBeInTheDocument();

    // Cycle the harness to dirty the form; the save stays a sparse override.
    await user.click(within(row).getByRole("combobox", { name: "Agent harness" }));
    await user.click(await screen.findByRole("option", { name: "OpenCode" }));
    await user.click(within(row).getByRole("combobox", { name: "Agent harness" }));
    await user.click(await screen.findByRole("option", { name: "Claude Agent" }));
    await user.click(within(row).getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/linear/repos/acme/web",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            allowUserPreferenceOverride: true,
            allowLabelModelOverride: true,
            emitToolProgressActivities: true,
            harness: "claude",
          },
        }),
      })
    );
  }, 20000);
});
