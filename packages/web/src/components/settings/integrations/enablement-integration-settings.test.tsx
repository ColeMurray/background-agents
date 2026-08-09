// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { CodeServerIntegrationSettings } from "./code-server-integration-settings";
import { VncIntegrationSettings } from "./vnc-integration-settings";

expect.extend(matchers);

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
const nestedRepo = "group/subgroup/web";

interface EnablementSettings {
  enabled?: boolean;
}

interface RepoSettingsEntry {
  repo: string;
  settings: EnablementSettings;
}

function setupSWR(
  integrationId: string,
  opts: {
    global?: { defaults?: EnablementSettings; enabledRepos?: string[] } | null;
    repos?: RepoSettingsEntry[];
    availableRepos?: EnrichedRepository[];
  }
) {
  useSWRMock.mockImplementation((key: string) => {
    if (key === `/api/integration-settings/${integrationId}`) {
      return {
        data: opts.global === undefined ? undefined : { settings: opts.global },
        isLoading: false,
      };
    }
    if (key === `/api/integration-settings/${integrationId}/repos`) {
      return { data: { repos: opts.repos ?? [] }, isLoading: false };
    }
    if (key === "/api/repos") {
      return { data: { repos: opts.availableRepos ?? [] }, isLoading: false };
    }
    return { data: undefined, isLoading: false };
  });
}

function repo(fullName: string): EnrichedRepository {
  return {
    fullName,
    private: false,
    description: null,
    htmlUrl: `https://gitlab.example/${fullName}`,
    defaultBranch: "main",
  } as unknown as EnrichedRepository;
}

function okJson(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

function overrideRow(fullName: string) {
  return screen.getByRole("group", { name: `${fullName} override` });
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

describe("code-server enablement integration settings", () => {
  const id = "code-server";
  const enableLabel = "Enable code-server";
  const Component = CodeServerIntegrationSettings;

  it("saves global enablement settings", async () => {
    const user = userEvent.setup();
    setupSWR(id, { global: null });
    fetchMock.mockResolvedValue(okJson({}));

    render(<Component />);

    await user.click(screen.getByRole("checkbox", { name: new RegExp(`^${enableLabel}`) }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integration-settings/${id}`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: { defaults: { enabled: true } } }),
      })
    );
  });

  it("resets global settings", async () => {
    const user = userEvent.setup();
    setupSWR(id, { global: { defaults: { enabled: true } } });
    fetchMock.mockResolvedValue(okJson({}));

    render(<Component />);

    await user.click(screen.getByRole("button", { name: /reset to defaults/i }));
    await user.click(screen.getByRole("button", { name: /^reset$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integration-settings/${id}`,
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("adds a nested-owner repository override", async () => {
    const user = userEvent.setup();
    setupSWR(id, {
      global: null,
      availableRepos: [repo(nestedRepo)],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<Component />);

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: nestedRepo }));
    await user.click(screen.getByRole("button", { name: /add override/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integration-settings/${id}/repos/group%2Fsubgroup/web`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: { enabled: true } }),
      })
    );
  });

  it("updates a nested-owner repository override", async () => {
    const user = userEvent.setup();
    setupSWR(id, {
      global: null,
      repos: [{ repo: nestedRepo, settings: { enabled: true } }],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<Component />);

    const row = overrideRow(nestedRepo);
    await user.click(within(row).getByRole("checkbox", { name: /enabled/i }));
    await user.click(within(row).getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integration-settings/${id}/repos/group%2Fsubgroup/web`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: { enabled: false } }),
      })
    );
  });

  it("deletes a nested-owner repository override", async () => {
    const user = userEvent.setup();
    setupSWR(id, {
      global: null,
      repos: [{ repo: nestedRepo, settings: { enabled: false } }],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<Component />);

    await user.click(within(overrideRow(nestedRepo)).getByRole("button", { name: /remove/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/integration-settings/${id}/repos/group%2Fsubgroup/web`,
      expect.objectContaining({ method: "DELETE" })
    );
  });
});

describe("VNC enablement integration settings", () => {
  it("routes saves through the VNC integration", async () => {
    const user = userEvent.setup();
    setupSWR("vnc", { global: null });
    fetchMock.mockResolvedValue(okJson({}));

    render(<VncIntegrationSettings />);

    expect(screen.getByRole("heading", { name: "VNC Desktop" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /^Enable VNC desktop/ }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/vnc",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: { defaults: { enabled: true } } }),
      })
    );
  });
});
