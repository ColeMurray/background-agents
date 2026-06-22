// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig, mutate as globalMutate } from "swr";
import { ModelApiKeysSettings } from "./model-api-keys-settings";

expect.extend(matchers);

const DEDUPING_INTERVAL_MS = Number.POSITIVE_INFINITY;

const { reposMock, toastMock } = vi.hoisted(() => ({
  reposMock: {
    repos: [
      {
        id: 1,
        fullName: "acme/app",
        owner: "acme",
        name: "app",
        description: null,
        private: true,
        defaultBranch: "main",
      },
    ],
    loading: false,
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: reposMock.repos, loading: reposMock.loading }),
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderWithSWR(fallback: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT" || init?.method === "DELETE") {
      return jsonResponse({ status: "ok" });
    }
    throw new Error("unexpected fetch");
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback,
        dedupingInterval: DEDUPING_INTERVAL_MS,
        revalidateOnFocus: false,
        revalidateIfStale: false,
        revalidateOnReconnect: false,
      }}
    >
      <ModelApiKeysSettings />
    </SWRConfig>
  );

  return { ...result, fetchMock };
}

async function selectRepo() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /All Repositories/ }));
  await user.click(screen.getByRole("option", { name: /app/ }));
}

afterEach(async () => {
  cleanup();
  await globalMutate(() => true, undefined, { revalidate: false });
  vi.restoreAllMocks();
  reposMock.loading = false;
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

describe("ModelApiKeysSettings", () => {
  it("saves model API keys to global secrets by default", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithSWR({
      "/api/secrets": { secrets: [] },
    });

    await user.type(screen.getByLabelText("Anthropic API key"), "sk-ant-test");
    await user.type(screen.getByLabelText("OpenAI API key"), "sk-openai-test");
    await user.click(screen.getByRole("button", { name: "Save API Keys" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/secrets",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            secrets: {
              ANTHROPIC_API_KEY: "sk-ant-test",
              OPENAI_API_KEY: "sk-openai-test",
            },
          }),
        })
      );
    });
  });

  it("shows repo keys as set and global keys as inherited", async () => {
    renderWithSWR({
      "/api/secrets": { secrets: [] },
      "/api/repos/acme/app/secrets": {
        secrets: [{ key: "OPENAI_API_KEY" }],
        globalSecrets: [{ key: "ANTHROPIC_API_KEY" }],
      },
    });

    await selectRepo();

    expect(await screen.findByText("Inherited")).toBeInTheDocument();
    expect(await screen.findByText("Set")).toBeInTheDocument();
  });

  it("saves repo overrides to the selected repository secrets endpoint", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithSWR({
      "/api/secrets": { secrets: [] },
      "/api/repos/acme/app/secrets": {
        secrets: [],
        globalSecrets: [{ key: "ANTHROPIC_API_KEY" }],
      },
    });

    await selectRepo();
    await user.type(screen.getByLabelText("Anthropic API key"), "sk-ant-repo");
    await user.click(screen.getByRole("button", { name: "Save API Keys" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/repos/acme/app/secrets",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            secrets: {
              ANTHROPIC_API_KEY: "sk-ant-repo",
            },
          }),
        })
      );
    });
  });

  it("deletes only the direct key for the selected repository", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithSWR({
      "/api/secrets": { secrets: [] },
      "/api/repos/acme/app/secrets": {
        secrets: [{ key: "OPENAI_API_KEY" }],
        globalSecrets: [{ key: "ANTHROPIC_API_KEY" }],
      },
    });

    await selectRepo();
    await user.click(screen.getByRole("button", { name: "Remove OPENAI_API_KEY" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/repos/acme/app/secrets/OPENAI_API_KEY", {
        method: "DELETE",
      });
    });
  });
});
