// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
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

function CachedModels() {
  const { enabledModels } = useEnabledModels();
  return <span data-testid="cached-models">{JSON.stringify(enabledModels)}</span>;
}

function renderSettings(enabledModels = ["openai/gpt-5.4"]) {
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
      <ModelsSettings />
      <CachedModels />
    </SWRConfig>
  );
}

describe("ModelsSettings", () => {
  it("automatically saves toggles and updates other model selectors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
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
    let resolve!: (response: { ok: boolean }) => void;
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
    expect(screen.getByRole("status")).toHaveTextContent("Saving...");
    for (const control of [...screen.getAllByRole("switch"), ...screen.getAllByRole("button")]) {
      expect(control).toBeDisabled();
    }
    await user.click(screen.getByRole("switch", { name: /GPT 5.4/ }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ok: true }));
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
      fetchMock.mockResolvedValue({ ok: true });
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
});
