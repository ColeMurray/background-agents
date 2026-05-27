// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type {
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
  globalLoading?: boolean;
  reposLoading?: boolean;
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
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<SlackIntegrationSettings />);

    await user.click(screen.getByRole("combobox", { name: /select a repository/i }));
    await user.click(await screen.findByRole("option", { name: "acme/web" }));
    await user.click(screen.getByRole("button", { name: /add override/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/slack/repos/acme/web",
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
});
