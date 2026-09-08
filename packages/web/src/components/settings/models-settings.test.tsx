// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { MODEL_PREFERENCES_KEY } from "@/hooks/use-enabled-models";
import { ModelsSettings } from "./models-settings";

expect.extend(matchers);

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ModelsSettings", () => {
  it("does not count or submit removed models from stored preferences", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            [MODEL_PREFERENCES_KEY]: {
              enabledModels: ["openai/gpt-5.2", "openai/gpt-5.4"],
            },
          },
          revalidateIfStale: false,
        }}
      >
        <ModelsSettings />
      </SWRConfig>
    );

    await user.click(screen.getByRole("switch", { name: /GPT 5.4/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      enabledModels: ["openai/gpt-5.4"],
    });
  });
});
