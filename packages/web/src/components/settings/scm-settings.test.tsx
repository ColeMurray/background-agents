// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ScmGlobalConfig, ScmSettings } from "@open-inspect/shared";
import { getScmRepoSettingsPath, ScmSettingsPage } from "./scm-settings";

expect.extend(matchers);

interface RepoSettingsEntry {
  repo: string;
  settings: ScmSettings;
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

let globalSettings: ScmGlobalConfig | null;
let repoSettings: RepoSettingsEntry[];

beforeEach(() => {
  globalSettings = { defaults: { alwaysUseDraftMode: false } };
  repoSettings = [{ repo: "acme/web", settings: { alwaysUseDraftMode: false } }];
  mutateMock.mockReset();
  useSWRMock.mockReset();
  useSWRMock.mockImplementation((key: string) => {
    if (key === "/api/scm-settings") {
      return { data: { settings: globalSettings }, isLoading: false };
    }
    if (key === "/api/scm-settings/repos") {
      return { data: { repos: repoSettings }, isLoading: false };
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

    globalSettings = { defaults: { alwaysUseDraftMode: true } };
    repoSettings = [{ repo: "acme/web", settings: { alwaysUseDraftMode: true } }];
    rerender(<ScmSettingsPage />);

    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
      expect(screen.getAllByRole("checkbox")[1]).toBeChecked();
    });

    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getAllByRole("checkbox")[1]);

    globalSettings = { defaults: { alwaysUseDraftMode: true } };
    repoSettings = [{ repo: "acme/web", settings: { alwaysUseDraftMode: true } }];
    rerender(<ScmSettingsPage />);

    expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
    expect(screen.getAllByRole("checkbox")[1]).not.toBeChecked();
  });
});
