// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig, useSWRConfig } from "swr";
import { toast } from "sonner";
import { MODEL_OPTIONS } from "@open-inspect/shared/models";
import { MODEL_PREFERENCES_KEY, useEnabledModels } from "@/hooks/use-enabled-models";
import { ModelsSettings } from "./models-settings";

expect.extend(matchers);

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function saveResponse(_url: unknown, init: RequestInit) {
  return { ok: true, json: async () => JSON.parse(init.body as string) };
}

function CachedModels() {
  const { enabledModels } = useEnabledModels();
  return <span data-testid="cached-models">{JSON.stringify(enabledModels)}</span>;
}

function NavigableSettings() {
  const [showModels, setShowModels] = useState(true);
  return (
    <>
      <button onClick={() => setShowModels(!showModels)}>
        {showModels ? "Other settings" : "Models"}
      </button>
      {showModels && <ModelsSettings />}
    </>
  );
}

function renderSettings(
  enabledModels = ["openai/gpt-5.4"],
  children: ReactNode = <ModelsSettings />
) {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: {
          [MODEL_PREFERENCES_KEY]: {
            enabledModels,
          },
        },
        revalidateIfStale: false,
      }}
    >
      {children}
      <CachedModels />
    </SWRConfig>
  );
}

describe("ModelsSettings", () => {
  it("automatically saves toggles and updates other model selectors", async () => {
    const fetchMock = vi.fn(saveResponse);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderSettings(["openai/gpt-5.2", "openai/gpt-5.4"]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: /Claude Haiku 4.5/ }));
    await waitFor(() => expect(screen.getByRole("status")).toBeEmptyDOMElement());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/model-preferences",
      expect.objectContaining({ method: "PUT" })
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      enabledModels: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"],
    });
    expect(JSON.parse(screen.getByTestId("cached-models").textContent!)).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-haiku-4-5",
    ]);
    await user.click(screen.getByRole("switch", { name: /GPT 5.4/ }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      enabledModels: ["anthropic/claude-haiku-4-5"],
    });
  });

  it("automatically saves category actions", async () => {
    const fetchMock = vi.fn(saveResponse);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderSettings();
    const category = within(screen.getByRole("heading", { name: "Anthropic" }).parentElement!);
    await user.click(category.getByRole("button", { name: "Enable all" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      enabledModels: ["openai/gpt-5.4", ...MODEL_OPTIONS[0].models.map((model) => model.id)],
    });
    await user.click(category.getByRole("button", { name: "Disable all" }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      enabledModels: ["openai/gpt-5.4"],
    });
  });

  it("does not save when disabling the last model or last category", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { unmount } = renderSettings(["openai/gpt-5.2", "openai/gpt-5.4"]);
    await user.click(screen.getByRole("switch", { name: /GPT 5.4/ }));
    expect(screen.getByRole("switch", { name: /GPT 5.4/ })).toBeChecked();
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
    renderSettings(MODEL_OPTIONS[0].models.map((model) => model.id));
    await user.click(screen.getByRole("button", { name: "Disable all" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: /Claude Haiku 4.5/ })).toBeChecked();
  });

  it("prevents overlapping saves while showing the new selection immediately", async () => {
    let resolve!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("switch", { name: /Claude Haiku 4.5/ }));
    expect(screen.getByRole("switch", { name: /Claude Haiku 4.5/ })).toBeChecked();
    expect(screen.getByTestId("cached-models")).toHaveTextContent("anthropic/claude-haiku-4-5");
    expect(screen.getByRole("status")).toHaveTextContent("Saving...");
    for (const control of [...screen.getAllByRole("switch"), ...screen.getAllByRole("button")]) {
      expect(control).toBeDisabled();
    }
    await user.click(screen.getByRole("switch", { name: /GPT 5.4/ }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolve({
        ok: true,
        json: async () => ({ enabledModels: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"] }),
      })
    );
    expect(screen.getByRole("switch", { name: /GPT 5.4/ })).toBeEnabled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it.each(["server", "network"])(
    "restores the previous selection after a %s failure and allows retry",
    async (failure) => {
      const fetchMock = vi.fn();
      if (failure === "server") {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          json: async () => ({ error: "Save denied" }),
        });
      } else {
        fetchMock.mockRejectedValueOnce(new Error("Network unavailable"));
      }
      fetchMock.mockImplementation(saveResponse);
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      renderSettings();
      const toggle = screen.getByRole("switch", { name: /Claude Haiku 4.5/ });
      await user.click(toggle);
      await waitFor(() => expect(toggle).toBeEnabled());
      expect(toggle).not.toBeChecked();
      expect(screen.getByTestId("cached-models")).toHaveTextContent('["openai/gpt-5.4"]');
      expect(toast.error).toHaveBeenCalledWith(
        failure === "server" ? "Save denied" : "Network unavailable"
      );
      await user.click(toggle);
      await waitFor(() => expect(toggle).toBeEnabled());
      expect(toggle).toBeChecked();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  it.each([true, false])(
    "preserves the pending selection and lock across navigation (success: %s)",
    async (ok) => {
      let resolve!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
      const fetchMock = vi
        .fn()
        .mockReturnValueOnce(
          new Promise((done) => {
            resolve = done;
          })
        )
        .mockImplementation(saveResponse);
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      renderSettings(undefined, <NavigableSettings />);

      await user.click(screen.getByRole("switch", { name: /Claude Haiku 4.5/ }));
      await user.click(screen.getByRole("button", { name: "Other settings" }));
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Models" }));

      expect(screen.getByRole("switch", { name: /Claude Haiku 4.5/ })).toBeChecked();
      expect(screen.getByRole("status")).toHaveTextContent("Saving...");
      for (const control of screen.getAllByRole("switch")) {
        expect(control).toBeDisabled();
      }
      await user.click(screen.getByRole("switch", { name: /GPT 5.4/ }));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () =>
        resolve({
          ok,
          json: async () =>
            ok
              ? { enabledModels: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"] }
              : { error: "Save denied" },
        })
      );
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      const haiku = screen.getByRole("switch", { name: /Claude Haiku 4.5/ });
      expect(haiku).toBeEnabled();
      expect(haiku).toHaveAttribute("aria-checked", String(ok));

      await user.click(screen.getByRole("switch", { name: /Claude Sonnet 4.6/ }));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
        enabledModels: [
          "openai/gpt-5.4",
          ...(ok ? ["anthropic/claude-haiku-4-5"] : []),
          "anthropic/claude-sonnet-4-6",
        ],
      });
    }
  );

  it("uses external cache updates for both the switches and the next save", async () => {
    let updateCache!: ReturnType<typeof useSWRConfig>["mutate"];
    function CacheAccess() {
      updateCache = useSWRConfig().mutate;
      return <ModelsSettings />;
    }
    const fetchMock = vi.fn(saveResponse);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderSettings(undefined, <CacheAccess />);
    await act(async () => {
      await updateCache(
        MODEL_PREFERENCES_KEY,
        {
          enabledModels: ["anthropic/claude-sonnet-4-6"],
        },
        { revalidate: false }
      );
    });
    expect(screen.getByRole("switch", { name: /GPT 5.4/ })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: /Claude Sonnet 4.6/ })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: /Claude Haiku 4.5/ }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      enabledModels: ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"],
    });
  });

  it("does not offer writable defaults after an initial read failure", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("Unavailable"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SWRConfig value={{ provider: () => new Map(), fetcher, shouldRetryOnError: false }}>
        <ModelsSettings />
      </SWRConfig>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load model preferences");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
