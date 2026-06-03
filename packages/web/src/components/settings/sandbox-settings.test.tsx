// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import {
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
  MAX_TUNNEL_PORTS,
} from "@open-inspect/shared";
import { SandboxSettingsPage } from "./sandbox-settings";

expect.extend(matchers);

const reposMock = vi.hoisted(() => ({
  repos: [] as Array<{
    id: number;
    fullName: string;
    owner: string;
    name: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
  }>,
  loading: false,
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: reposMock.repos, loading: reposMock.loading }),
}));

const SETTINGS_KEY = "/api/integration-settings/sandbox";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SANDBOX_PROVIDER", "modal");
});

function globalSettings(
  tunnelPorts: number[],
  enabledRepos?: string[],
  limits?: { maxConcurrentChildSessions?: number; maxTotalChildSessions?: number }
) {
  return {
    integrationId: "sandbox",
    settings: { defaults: { tunnelPorts, ...limits }, enabledRepos },
  };
}

function renderWithSWR(fallbackData: unknown) {
  const fetchMock = vi.fn(async () => {
    throw new Error("unexpected fetch");
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: { [SETTINGS_KEY]: fallbackData },
        dedupingInterval: Infinity,
        revalidateOnFocus: false,
        revalidateIfStale: false,
        revalidateOnReconnect: false,
      }}
    >
      <SandboxSettingsPage />
    </SWRConfig>
  );
  return { ...result, fetchMock };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  reposMock.repos = [];
  reposMock.loading = false;
});

describe("SandboxSettingsPage — tunnel ports editor", () => {
  const user = userEvent.setup();

  it("shows empty state when no ports configured", () => {
    renderWithSWR({ integrationId: "sandbox", settings: null });
    expect(screen.getByText("No tunnel ports configured.")).toBeInTheDocument();
  });

  it("renders existing ports as individual input rows", () => {
    renderWithSWR(globalSettings([3000, 5173]));

    const inputs = screen.getAllByPlaceholderText("e.g. 3000");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toHaveValue("3000");
    expect(inputs[1]).toHaveValue("5173");
  });

  it("adds a new empty row when clicking Add port", async () => {
    renderWithSWR({ integrationId: "sandbox", settings: null });
    expect(screen.getByText("No tunnel ports configured.")).toBeInTheDocument();

    await user.click(screen.getByText("Add port"));

    expect(screen.queryByText("No tunnel ports configured.")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. 3000")).toHaveValue("");
  });

  it("removes a row when clicking Remove", async () => {
    renderWithSWR(globalSettings([3000, 5173]));
    expect(screen.getAllByPlaceholderText("e.g. 3000")).toHaveLength(2);

    const removeButtons = screen.getAllByText("Remove");
    await user.click(removeButtons[0]);

    const inputs = screen.getAllByPlaceholderText("e.g. 3000");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toHaveValue("5173");
  });

  it("updates port value when typing", async () => {
    renderWithSWR({ integrationId: "sandbox", settings: null });
    await user.click(screen.getByText("Add port"));

    const input = screen.getByPlaceholderText("e.g. 3000");
    await user.type(input, "8080");
    expect(input).toHaveValue("8080");
  });

  it("disables Add port button at MAX_TUNNEL_PORTS", () => {
    const ports = Array.from({ length: MAX_TUNNEL_PORTS }, (_, i) => 3000 + i);
    renderWithSWR(globalSettings(ports));

    expect(screen.getByText("Add port").closest("button")).toBeDisabled();
  });

  it("keeps Save disabled when only invalid input is entered", async () => {
    renderWithSWR({ integrationId: "sandbox", settings: null });
    await user.click(screen.getByText("Add port"));

    await user.type(screen.getByPlaceholderText("e.g. 3000"), "abc");

    expect(screen.getByText("Save Settings").closest("button")).toBeDisabled();
  });

  it("shows validation error for mixed valid and invalid ports", async () => {
    const { fetchMock } = renderWithSWR({ integrationId: "sandbox", settings: null });
    await user.click(screen.getByText("Add port"));
    await user.click(screen.getByText("Add port"));

    const inputs = screen.getAllByPlaceholderText("e.g. 3000");
    await user.type(inputs[0], "3000");
    await user.type(inputs[1], "abc");
    await user.click(screen.getByText("Save Settings"));

    expect(screen.getByText(/Invalid port numbers/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      SETTINGS_KEY,
      expect.objectContaining({ method: "PUT" })
    );
  });

  it("sends correct global payload on save", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: { [SETTINGS_KEY]: globalSettings([], ["acme/app"]) },
          dedupingInterval: Infinity,
          revalidateOnFocus: false,
          revalidateIfStale: false,
          revalidateOnReconnect: false,
        }}
      >
        <SandboxSettingsPage />
      </SWRConfig>
    );

    await user.click(screen.getByText("Add port"));
    await user.type(screen.getByPlaceholderText("e.g. 3000"), "8080");
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        SETTINGS_KEY,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            settings: {
              defaults: {
                tunnelPorts: [8080],
                terminalEnabled: false,
                dockerEnabled: false,
                maxConcurrentChildSessions: DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
                maxTotalChildSessions: DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
              },
              enabledRepos: ["acme/app"],
            },
          }),
        })
      );
    });
  });

  it("renders child session limits from settings", () => {
    renderWithSWR(
      globalSettings([], undefined, {
        maxConcurrentChildSessions: 3,
        maxTotalChildSessions: 9,
      })
    );

    expect(screen.getByLabelText("Max concurrent child sessions")).toHaveValue(3);
    expect(screen.getByLabelText("Max total child sessions")).toHaveValue(9);
  });

  it("sends child session limits in the global payload", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: { [SETTINGS_KEY]: globalSettings([], ["acme/app"]) },
          dedupingInterval: Infinity,
          revalidateOnFocus: false,
          revalidateIfStale: false,
          revalidateOnReconnect: false,
        }}
      >
        <SandboxSettingsPage />
      </SWRConfig>
    );

    await user.clear(screen.getByLabelText("Max concurrent child sessions"));
    await user.type(screen.getByLabelText("Max concurrent child sessions"), "2");
    await user.clear(screen.getByLabelText("Max total child sessions"));
    await user.type(screen.getByLabelText("Max total child sessions"), "7");
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        SETTINGS_KEY,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            settings: {
              defaults: {
                tunnelPorts: [],
                terminalEnabled: false,
                dockerEnabled: false,
                maxConcurrentChildSessions: 2,
                maxTotalChildSessions: 7,
              },
              enabledRepos: ["acme/app"],
            },
          }),
        })
      );
    });
  });

  it("blocks invalid child session limits", async () => {
    const { fetchMock } = renderWithSWR(globalSettings([]));

    await user.clear(screen.getByLabelText("Max concurrent child sessions"));
    await user.type(screen.getByLabelText("Max concurrent child sessions"), "0");
    await user.click(screen.getByText("Save Settings"));

    expect(
      screen.getByText("Child session limits must be positive whole numbers.")
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      SETTINGS_KEY,
      expect.objectContaining({ method: "PUT" })
    );
  });

  it("shows inherited repo child session limits without saving them as overrides", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    reposMock.repos = [
      {
        id: 1,
        fullName: "acme/app",
        owner: "acme",
        name: "app",
        description: null,
        private: false,
        defaultBranch: "main",
      },
    ];
    const repoSettingsKey = "/api/integration-settings/sandbox/repos/acme/app";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            [SETTINGS_KEY]: globalSettings([], undefined, {
              maxConcurrentChildSessions: 2,
              maxTotalChildSessions: 7,
            }),
            [repoSettingsKey]: { integrationId: "sandbox", repo: "acme/app", settings: null },
          },
          dedupingInterval: Infinity,
          revalidateOnFocus: false,
          revalidateIfStale: false,
          revalidateOnReconnect: false,
        }}
      >
        <SandboxSettingsPage />
      </SWRConfig>
    );

    await user.click(screen.getByText("All Repositories (Global)"));
    await user.click(screen.getByRole("option", { name: /app/ }));

    expect(screen.getByLabelText("Max concurrent child sessions")).toHaveValue(2);
    expect(screen.getByLabelText("Max total child sessions")).toHaveValue(7);

    await user.click(screen.getByText("Add port"));
    await user.type(screen.getByPlaceholderText("e.g. 3000"), "3000");
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        repoSettingsKey,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            settings: { tunnelPorts: [3000], terminalEnabled: false },
          }),
        })
      );
    });
  });

  it("deduplicates ports on save", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: { [SETTINGS_KEY]: { integrationId: "sandbox", settings: null } },
          dedupingInterval: Infinity,
          revalidateOnFocus: false,
          revalidateIfStale: false,
          revalidateOnReconnect: false,
        }}
      >
        <SandboxSettingsPage />
      </SWRConfig>
    );

    await user.click(screen.getByText("Add port"));
    const inputs1 = screen.getAllByPlaceholderText("e.g. 3000");
    await user.type(inputs1[0], "3000");

    await user.click(screen.getByText("Add port"));
    const inputs2 = screen.getAllByPlaceholderText("e.g. 3000");
    await user.type(inputs2[1], "3000");

    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        SETTINGS_KEY,
        expect.objectContaining({
          body: JSON.stringify({
            settings: {
              defaults: {
                tunnelPorts: [3000],
                terminalEnabled: false,
                dockerEnabled: false,
                maxConcurrentChildSessions: DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
                maxTotalChildSessions: DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
              },
            },
          }),
        })
      );
    });
  });

  it("keeps Save disabled when no changes made", () => {
    renderWithSWR(globalSettings([3000]));
    expect(screen.getByText("Save Settings").closest("button")).toBeDisabled();
  });

  it("keeps Save disabled when adding a duplicate of an existing port", async () => {
    renderWithSWR(globalSettings([3000]));
    await user.click(screen.getByText("Add port"));

    const inputs = screen.getAllByPlaceholderText("e.g. 3000");
    await user.type(inputs[1], "3000");

    expect(screen.getByText("Save Settings").closest("button")).toBeDisabled();
  });

  it("hides Docker control for non-Modal sandbox providers", () => {
    vi.stubEnv("NEXT_PUBLIC_SANDBOX_PROVIDER", "daytona");
    renderWithSWR(globalSettings([]));
    expect(screen.queryByText("Docker")).not.toBeInTheDocument();
  });

  it("preserves Docker settings when saving other global settings for non-Modal providers", async () => {
    vi.stubEnv("NEXT_PUBLIC_SANDBOX_PROVIDER", "daytona");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            [SETTINGS_KEY]: {
              integrationId: "sandbox",
              settings: { defaults: { tunnelPorts: [], dockerEnabled: true } },
            },
          },
          dedupingInterval: Infinity,
          revalidateOnFocus: false,
          revalidateIfStale: false,
          revalidateOnReconnect: false,
        }}
      >
        <SandboxSettingsPage />
      </SWRConfig>
    );

    await user.click(screen.getByText("Add port"));
    await user.type(screen.getByPlaceholderText("e.g. 3000"), "3000");
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        SETTINGS_KEY,
        expect.objectContaining({ method: "PUT" })
      );
    });

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(putCall).toBeDefined();
    const [, init] = putCall!;
    expect(JSON.parse(String(init?.body))).toEqual({
      settings: {
        defaults: {
          tunnelPorts: [3000],
          terminalEnabled: false,
          dockerEnabled: true,
          maxConcurrentChildSessions: DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
          maxTotalChildSessions: DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
        },
      },
    });
  });

  it("does not add Docker settings when saving non-Modal sandbox settings", async () => {
    vi.stubEnv("NEXT_PUBLIC_SANDBOX_PROVIDER", "daytona");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            [SETTINGS_KEY]: {
              integrationId: "sandbox",
              settings: { defaults: { tunnelPorts: [] } },
            },
          },
          dedupingInterval: Infinity,
          revalidateOnFocus: false,
          revalidateIfStale: false,
          revalidateOnReconnect: false,
        }}
      >
        <SandboxSettingsPage />
      </SWRConfig>
    );

    await user.click(screen.getByText("Add port"));
    await user.type(screen.getByPlaceholderText("e.g. 3000"), "3000");
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        SETTINGS_KEY,
        expect.objectContaining({ method: "PUT" })
      );
    });

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(putCall).toBeDefined();
    const [, init] = putCall!;
    expect(JSON.parse(String(init?.body))).toEqual({
      settings: {
        defaults: {
          tunnelPorts: [3000],
          terminalEnabled: false,
          maxConcurrentChildSessions: DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
          maxTotalChildSessions: DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
        },
      },
    });
  });

  it("sends dockerEnabled in the global payload when enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_SANDBOX_PROVIDER", "modal");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: { [SETTINGS_KEY]: globalSettings([]) },
          dedupingInterval: Infinity,
          revalidateOnFocus: false,
          revalidateIfStale: false,
          revalidateOnReconnect: false,
        }}
      >
        <SandboxSettingsPage />
      </SWRConfig>
    );

    await user.click(screen.getByRole("switch", { name: "Docker" }));
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        SETTINGS_KEY,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            settings: {
              defaults: {
                tunnelPorts: [],
                terminalEnabled: false,
                dockerEnabled: true,
                maxConcurrentChildSessions: DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
                maxTotalChildSessions: DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
              },
            },
          }),
        })
      );
    });
  });

  it("lets repo Docker settings inherit without saving a dockerEnabled override", async () => {
    vi.stubEnv("NEXT_PUBLIC_SANDBOX_PROVIDER", "modal");
    Element.prototype.scrollIntoView = vi.fn();
    reposMock.repos = [
      {
        id: 1,
        fullName: "acme/app",
        owner: "acme",
        name: "app",
        description: null,
        private: false,
        defaultBranch: "main",
      },
    ];
    const repoSettingsKey = "/api/integration-settings/sandbox/repos/acme/app";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            [SETTINGS_KEY]: {
              integrationId: "sandbox",
              settings: { defaults: { tunnelPorts: [], dockerEnabled: true } },
            },
            [repoSettingsKey]: { integrationId: "sandbox", repo: "acme/app", settings: null },
          },
          dedupingInterval: Infinity,
          revalidateOnFocus: false,
          revalidateIfStale: false,
          revalidateOnReconnect: false,
        }}
      >
        <SandboxSettingsPage />
      </SWRConfig>
    );

    await user.click(screen.getByText("All Repositories (Global)"));
    await user.click(screen.getByRole("option", { name: /app/ }));
    expect(screen.getByLabelText("Docker")).toHaveValue("inherit");

    await user.click(screen.getByText("Add port"));
    await user.type(screen.getByPlaceholderText("e.g. 3000"), "3000");
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        repoSettingsKey,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            settings: { tunnelPorts: [3000], terminalEnabled: false },
          }),
        })
      );
    });
  });

  it("clears an existing repo Docker override when switching back to inherit", async () => {
    vi.stubEnv("NEXT_PUBLIC_SANDBOX_PROVIDER", "modal");
    Element.prototype.scrollIntoView = vi.fn();
    reposMock.repos = [
      {
        id: 1,
        fullName: "acme/app",
        owner: "acme",
        name: "app",
        description: null,
        private: false,
        defaultBranch: "main",
      },
    ];
    const repoSettingsKey = "/api/integration-settings/sandbox/repos/acme/app";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            [SETTINGS_KEY]: {
              integrationId: "sandbox",
              settings: { defaults: { tunnelPorts: [], dockerEnabled: true } },
            },
            [repoSettingsKey]: {
              integrationId: "sandbox",
              repo: "acme/app",
              settings: { tunnelPorts: [], terminalEnabled: false, dockerEnabled: false },
            },
          },
          dedupingInterval: Infinity,
          revalidateOnFocus: false,
          revalidateIfStale: false,
          revalidateOnReconnect: false,
        }}
      >
        <SandboxSettingsPage />
      </SWRConfig>
    );

    await user.click(screen.getByText("All Repositories (Global)"));
    await user.click(screen.getByRole("option", { name: /app/ }));
    expect(screen.getByLabelText("Docker")).toHaveValue("disabled");

    await user.selectOptions(screen.getByLabelText("Docker"), "inherit");
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        repoSettingsKey,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            settings: { tunnelPorts: [], terminalEnabled: false },
          }),
        })
      );
    });
  });

  it("saves explicit disabled Docker override for a repo", async () => {
    vi.stubEnv("NEXT_PUBLIC_SANDBOX_PROVIDER", "modal");
    Element.prototype.scrollIntoView = vi.fn();
    reposMock.repos = [
      {
        id: 1,
        fullName: "acme/app",
        owner: "acme",
        name: "app",
        description: null,
        private: false,
        defaultBranch: "main",
      },
    ];
    const repoSettingsKey = "/api/integration-settings/sandbox/repos/acme/app";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            [SETTINGS_KEY]: {
              integrationId: "sandbox",
              settings: { defaults: { tunnelPorts: [], dockerEnabled: true } },
            },
            [repoSettingsKey]: { integrationId: "sandbox", repo: "acme/app", settings: null },
          },
          dedupingInterval: Infinity,
          revalidateOnFocus: false,
          revalidateIfStale: false,
          revalidateOnReconnect: false,
        }}
      >
        <SandboxSettingsPage />
      </SWRConfig>
    );

    await user.click(screen.getByText("All Repositories (Global)"));
    await user.click(screen.getByRole("option", { name: /app/ }));
    await user.selectOptions(screen.getByLabelText("Docker"), "disabled");
    await user.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        repoSettingsKey,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            settings: { tunnelPorts: [], terminalEnabled: false, dockerEnabled: false },
          }),
        })
      );
    });
  });
});
