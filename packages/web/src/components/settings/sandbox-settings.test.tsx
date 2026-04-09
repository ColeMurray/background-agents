// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { MAX_TUNNEL_PORTS } from "@open-inspect/shared";
import { SandboxSettingsPage } from "./sandbox-settings";

expect.extend(matchers);

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: [], loading: false }),
}));

const SETTINGS_KEY = "/api/integration-settings/sandbox";

function globalSettings(tunnelPorts: number[], enabledRepos?: string[]) {
  return {
    integrationId: "sandbox",
    settings: { defaults: { tunnelPorts }, enabledRepos },
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
              defaults: { tunnelPorts: [8080], terminalEnabled: false },
              enabledRepos: ["acme/app"],
            },
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
            settings: { defaults: { tunnelPorts: [3000], terminalEnabled: false } },
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
});
