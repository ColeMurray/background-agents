// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ScmGlobalConfig, ScmRepoSettings } from "@open-inspect/shared";
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
  mutateMock.mockReset();
  useSWRMock.mockReset();
  useSWRMock.mockImplementation((key: string) => {
    if (key === "/api/scm-settings") {
      return { data: globalData, error: globalError, isLoading: false };
    }
    if (key === "/api/scm-settings/repos") {
      return { data: repoSettingsData, error: repoSettingsError, isLoading: false };
    }
    if (key === "/api/repos") {
      return { data: { repos: [] }, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });
});

afterEach(() => {
  cleanup();
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

    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
    expect(screen.getAllByRole("checkbox")[1]).not.toBeChecked();

    globalData = { settings: { defaults: { alwaysUseDraftMode: true } } };
    repoSettingsData = {
      repos: [{ repo: "acme/web", settings: { alwaysUseDraftMode: true } }],
    };
    rerender(<ScmSettingsPage />);

    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
      expect(screen.getAllByRole("checkbox")[1]).toBeChecked();
    });

    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getAllByRole("checkbox")[1]);

    globalData = { settings: { defaults: { alwaysUseDraftMode: true } } };
    repoSettingsData = {
      repos: [{ repo: "acme/web", settings: { alwaysUseDraftMode: true } }],
    };
    rerender(<ScmSettingsPage />);

    expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
    expect(screen.getAllByRole("checkbox")[1]).not.toBeChecked();
  });

  it("does not render editable controls when a required settings query fails", () => {
    globalError = new Error("request failed");

    render(<ScmSettingsPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load source control settings");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("does not render editable controls for an unexpected settings response", () => {
    repoSettingsData = { repos: [{ repo: "acme/web", settings: {} }] };

    render(<ScmSettingsPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load source control settings");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
