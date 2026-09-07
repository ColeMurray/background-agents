// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import useSWR, { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackGlobalSettingsResponse } from "@open-inspect/shared/types/integrations";
import {
  SLACK_GLOBAL_SETTINGS_KEY,
  useSlackGlobalSettingsEditor,
} from "./use-slack-global-settings-editor";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), revalidateIfStale: false }}>
      {children}
    </SWRConfig>
  );
}

describe("useSlackGlobalSettingsEditor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a newer real SWR snapshot after a failed update and sends section-only retries", async () => {
    const initial: SlackGlobalSettingsResponse = {
      integrationId: "slack",
      settings: { defaults: { routingRules: [{ keyword: "old", target: "acme/old" }] } },
    };
    const newer: SlackGlobalSettingsResponse = {
      integrationId: "slack",
      settings: { defaults: { routingRules: [{ keyword: "new", target: "acme/new" }] } },
    };
    const saved: SlackGlobalSettingsResponse = {
      integrationId: "slack",
      settings: {
        defaults: {
          agentNotificationsEnabled: true,
          mentionsPolicy: "allow",
          routingRules: [{ keyword: "new", target: "acme/new" }],
        },
      },
    };
    const failedResponse = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => failedResponse.promise)
      .mockResolvedValueOnce(Response.json(saved));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(
      () => {
        const settings = useSWR<SlackGlobalSettingsResponse>(SLACK_GLOBAL_SETTINGS_KEY, null, {
          fallbackData: initial,
        });
        return {
          data: settings.data,
          mutate: settings.mutate,
          editor: useSlackGlobalSettingsEditor(settings.mutate),
        };
      },
      { wrapper }
    );

    let failedSave!: Promise<boolean>;
    act(() => {
      failedSave = result.current.editor.saveDefaults({
        agentNotificationsEnabled: true,
        mentionsPolicy: "allow",
      });
    });
    await act(() => result.current.mutate(newer, { revalidate: false }));
    failedResponse.resolve(Response.json({ error: "Write rejected" }, { status: 503 }));
    await act(() => failedSave);

    expect(result.current.data).toEqual(newer);

    await act(() =>
      result.current.editor.saveDefaults({
        agentNotificationsEnabled: true,
        mentionsPolicy: "allow",
      })
    );

    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      section: "defaults",
      defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    expect(result.current.data).toEqual(saved);
  });

  it("revalidates after out-of-order responses finish", async () => {
    const initial: SlackGlobalSettingsResponse = {
      integrationId: "slack",
      settings: null,
    };
    const older: SlackGlobalSettingsResponse = {
      integrationId: "slack",
      settings: { defaults: { agentNotificationsEnabled: true } },
    };
    const authoritative: SlackGlobalSettingsResponse = {
      integrationId: "slack",
      settings: {
        defaults: {
          agentNotificationsEnabled: true,
          routingRules: [{ keyword: "frontend", target: "acme/web" }],
        },
      },
    };
    const defaultsResponse = deferred<Response>();
    const routingResponse = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => defaultsResponse.promise)
      .mockImplementationOnce(() => routingResponse.promise);
    const settingsFetcher = vi.fn().mockResolvedValue(authoritative);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(
      () => {
        const settings = useSWR<SlackGlobalSettingsResponse>(
          SLACK_GLOBAL_SETTINGS_KEY,
          settingsFetcher,
          { fallbackData: initial }
        );
        return {
          data: settings.data,
          editor: useSlackGlobalSettingsEditor(settings.mutate),
        };
      },
      { wrapper }
    );

    let defaultsSave!: Promise<boolean>;
    let routingSave!: Promise<boolean>;
    act(() => {
      defaultsSave = result.current.editor.saveDefaults({ agentNotificationsEnabled: true });
      routingSave = result.current.editor.saveRoutingRules([
        { keyword: "frontend", target: "acme/web" },
      ]);
    });

    routingResponse.resolve(Response.json(authoritative));
    await act(() => routingSave);
    expect(settingsFetcher).not.toHaveBeenCalled();

    defaultsResponse.resolve(Response.json(older));
    await act(() => defaultsSave);

    expect(settingsFetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(authoritative);
    expect(result.current.editor.saving).toBe(false);
  });
});
