// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ScmGlobalConfig, ScmRepoSettings } from "@open-inspect/shared/types/integrations";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { parseRepositoryFullName } from "@open-inspect/shared/types/repositories";
import { getScmRepoSettingsPath, ScmSettingsPage } from "./scm-settings";

expect.extend(matchers);

interface RepoSettingsEntry {
  repo: string;
  settings: ScmRepoSettings;
}

const { useSWRMock, mutateMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn(),
  mutateMock: vi.fn(),
}));

const fetchMock = vi.fn();

vi.mock("swr", () => ({
  default: useSWRMock,
  mutate: mutateMock,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let globalData: unknown;
let globalError: unknown;
let repoSettingsData: unknown;
let repoSettingsError: unknown;
let availableReposData: EnrichedRepository[];

function repo(fullName: string): EnrichedRepository {
  const repository = parseRepositoryFullName(fullName);
  if (!repository) throw new Error(`Invalid repository full name: ${fullName}`);
  return {
    id: 1,
    owner: repository.repoOwner,
    name: repository.repoName,
    fullName,
    private: false,
    description: null,
    defaultBranch: "main",
    archived: false,
  };
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
  globalData = {
    settings: { defaults: { alwaysUseDraftMode: false } } satisfies ScmGlobalConfig,
  };
  globalError = undefined;
  repoSettingsData = {
    repos: [
      { repo: "acme/web", settings: { alwaysUseDraftMode: false } },
    ] satisfies RepoSettingsEntry[],
  };
  repoSettingsError = undefined;
  availableReposData = [];
  mutateMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useSWRMock.mockReset();
  useSWRMock.mockImplementation((key: string) => {
    if (key === "/api/scm-settings") {
      return { data: globalData, error: globalError, isLoading: false };
    }
    if (key === "/api/scm-settings/repos") {
      return { data: repoSettingsData, error: repoSettingsError, isLoading: false };
    }
    if (key === "/api/repos") {
      return { data: { repos: availableReposData }, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("getScmRepoSettingsPath", () => {
  it("encodes a nested GitLab namespace as one owner segment", () => {
    expect(getScmRepoSettingsPath("group/subgroup/repo")).toBe(
      "/api/scm-settings/repos/group%2Fsubgroup/repo"
    );
  });

  it("rejects malformed repository names", () => {
    expect(getScmRepoSettingsPath("repo")).toBeNull();
  });

  it("synchronizes clean controls after revalidation without overwriting dirty edits", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ScmSettingsPage />);

    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(
      screen.getByRole("combobox", { name: "Draft mode override for acme/web" })
    ).toHaveTextContent("Override: ready unless requested");

    globalData = { settings: { defaults: { alwaysUseDraftMode: true } } };
    repoSettingsData = {
      repos: [{ repo: "acme/web", settings: { alwaysUseDraftMode: true } }],
    };
    rerender(<ScmSettingsPage />);

    await waitFor(() => {
      expect(screen.getByRole("checkbox")).toBeChecked();
      expect(
        screen.getByRole("combobox", { name: "Draft mode override for acme/web" })
      ).toHaveTextContent("Override: always draft");
    });

    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("combobox", { name: "Draft mode override for acme/web" }));
    await user.click(
      await screen.findByRole("option", { name: "Override: ready unless requested" })
    );

    globalData = { settings: { defaults: { alwaysUseDraftMode: true } } };
    repoSettingsData = {
      repos: [{ repo: "acme/web", settings: { alwaysUseDraftMode: true } }],
    };
    rerender(<ScmSettingsPage />);

    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(
      screen.getByRole("combobox", { name: "Draft mode override for acme/web" })
    ).toHaveTextContent("Override: ready unless requested");
  });

  it("does not render editable controls when a required settings query fails", () => {
    globalError = new Error("request failed");

    render(<ScmSettingsPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load source control settings");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("does not render editable controls for an unexpected settings response", () => {
    repoSettingsData = {
      repos: [{ repo: "acme/web", settings: { alwaysUseDraftMode: "yes" } }],
    };

    render(<ScmSettingsPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load source control settings");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("renders global and repository label settings", () => {
    globalData = {
      settings: {
        defaults: { alwaysUseDraftMode: false, pullRequestLabel: "global-generated" },
      },
    };
    repoSettingsData = {
      repos: [
        {
          repo: "acme/web",
          settings: { pullRequestLabel: "repo-generated" },
        },
      ],
    };

    render(<ScmSettingsPage />);

    expect(screen.getByRole("textbox", { name: "Pull request label" })).toHaveValue(
      "global-generated"
    );
    expect(
      screen.getByRole("textbox", { name: "Pull request label override for acme/web" })
    ).toHaveValue("repo-generated");
    expect(
      screen.getByRole("combobox", { name: "Draft mode override for acme/web" })
    ).toHaveTextContent("Inherit global (ready unless requested)");
  });

  it("trims and saves the global pull request label", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    render(<ScmSettingsPage />);

    const input = screen.getByRole("textbox", { name: "Pull request label" });
    await user.type(input, "  generated  ");
    await user.click(screen.getAllByRole("button", { name: "Save" })[0]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scm-settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: { alwaysUseDraftMode: false, pullRequestLabel: "generated" },
          },
        }),
      })
    );
  });

  it("trims and saves a repository pull request label override", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    repoSettingsData = {
      repos: [{ repo: "acme/web", settings: {} }],
    };
    render(<ScmSettingsPage />);

    const input = screen.getByRole("textbox", {
      name: "Pull request label override for acme/web",
    });
    await user.type(input, "  repo-generated  ");
    await user.click(screen.getAllByRole("button", { name: "Save" })[1]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scm-settings/repos/acme/web",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: { pullRequestLabel: "repo-generated" },
        }),
      })
    );
  });

  it("saves an explicit repository draft override independently", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    repoSettingsData = {
      repos: [{ repo: "acme/web", settings: {} }],
    };
    render(<ScmSettingsPage />);

    await user.click(screen.getByRole("combobox", { name: "Draft mode override for acme/web" }));
    await user.click(await screen.findByRole("option", { name: "Override: always draft" }));
    await user.click(screen.getAllByRole("button", { name: "Save" })[1]);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scm-settings/repos/acme/web",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: { alwaysUseDraftMode: true } }),
      })
    );
  });

  it("adds a repository override without snapshotting global settings", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    repoSettingsData = { repos: [] };
    availableReposData = [repo("group/subgroup/repository")];
    render(<ScmSettingsPage />);

    await user.click(screen.getByRole("combobox", { name: "Select a repository" }));
    await user.click(await screen.findByRole("option", { name: "group/subgroup/repository" }));
    await user.click(screen.getByRole("button", { name: "Add Override" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scm-settings/repos/group%2Fsubgroup/repository",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: {} }),
      })
    );
  });
});
