// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type {
  EnrichedRepository,
  GitHubBotSettings,
  GitHubGlobalConfig,
} from "@open-inspect/shared";
import { GitHubIntegrationSettings } from "./github-integration-settings";

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
    enabledModelOptions: [],
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
  it("repo auto-review override without an explicit value seeds from global default when saved", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: { defaults: { autoReviewOnOpen: false } },
      repos: [{ repo: "acme/web", settings: {} }],
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
        body: JSON.stringify({ settings: { autoReviewOnOpen: false } }),
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
