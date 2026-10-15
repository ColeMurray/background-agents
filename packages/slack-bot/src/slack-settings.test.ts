import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HARNESS } from "@open-inspect/shared/harnesses";
import type { Env } from "./types";
import { getSlackSettings } from "./slack-settings";

function makeEnv(fetch: ReturnType<typeof vi.fn>): Env {
  return {
    SERVICE_AUTH_SECRET: "test-secret",
    CONTROL_PLANE: { fetch },
  } as unknown as Env;
}

function settingsResponse(defaults: Record<string, unknown>) {
  return new Response(JSON.stringify({ settings: { defaults } }));
}

function captureWarnings() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

describe("getSlackSettings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the default model and session instructions from one fetch", async () => {
    const fetch = vi.fn().mockResolvedValue(
      settingsResponse({
        model: "anthropic/claude-sonnet-4-6",
        sessionInstructions: "Prefer minimal diffs.",
      })
    );

    await expect(getSlackSettings(makeEnv(fetch))).resolves.toEqual({
      harness: DEFAULT_HARNESS,
      defaultModel: "anthropic/claude-sonnet-4-6",
      sessionInstructions: "Prefer minimal diffs.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns the configured harness", async () => {
    const fetch = vi.fn().mockResolvedValue(settingsResponse({ harness: "claude" }));

    const config = await getSlackSettings(makeEnv(fetch));
    expect(config.harness).toBe("claude");
  });

  it("returns the default harness when unset", async () => {
    const fetch = vi.fn().mockResolvedValue(settingsResponse({}));

    const config = await getSlackSettings(makeEnv(fetch));
    expect(config.harness).toBe("opencode");
  });

  it("drops an invalid default model", async () => {
    const fetch = vi.fn().mockResolvedValue(settingsResponse({ model: "not-a-model" }));

    const config = await getSlackSettings(makeEnv(fetch));
    expect(config.defaultModel).toBeUndefined();
  });

  it("returns no instructions when unset", async () => {
    const fetch = vi.fn().mockResolvedValue(settingsResponse({}));

    const config = await getSlackSettings(makeEnv(fetch));
    expect(config.sessionInstructions).toBeUndefined();
  });

  it.each([{ settings: null }, { settings: {} }])(
    "returns an empty config without a warning when nothing is saved: %j",
    async (body) => {
      const warnings = captureWarnings();
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));

      await expect(getSlackSettings(makeEnv(fetch), "trace-1")).resolves.toEqual({
        harness: DEFAULT_HARNESS,
      });
      expect(warnings()).toEqual([]);
    }
  );

  it("returns an empty config and warns on a malformed settings response", async () => {
    const warnings = captureWarnings();
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ settings: { defaults: { model: 123 } } })));

    await expect(getSlackSettings(makeEnv(fetch), "trace-1")).resolves.toEqual({
      harness: DEFAULT_HARNESS,
    });
    expect(warnings()).toEqual([
      expect.objectContaining({ msg: "slack_settings.invalid_response", trace_id: "trace-1" }),
    ]);
  });

  it("returns no instructions when whitespace-only", async () => {
    const fetch = vi.fn().mockResolvedValue(settingsResponse({ sessionInstructions: "   \n" }));

    const config = await getSlackSettings(makeEnv(fetch));
    expect(config.sessionInstructions).toBeUndefined();
  });

  it("returns an empty config and warns on a non-OK response", async () => {
    const warnings = captureWarnings();
    const fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));

    await expect(getSlackSettings(makeEnv(fetch), "trace-1")).resolves.toEqual({
      harness: DEFAULT_HARNESS,
    });
    expect(warnings()).toEqual([
      expect.objectContaining({
        msg: "slack_settings.fetch_failed",
        trace_id: "trace-1",
        http_status: 500,
      }),
    ]);
  });

  it("returns an empty config and warns when the fetch throws", async () => {
    const warnings = captureWarnings();
    const fetch = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(getSlackSettings(makeEnv(fetch), "trace-1")).resolves.toEqual({
      harness: DEFAULT_HARNESS,
    });
    expect(warnings()).toEqual([
      expect.objectContaining({
        msg: "slack_settings.fetch_error",
        trace_id: "trace-1",
        error_message: "network down",
      }),
    ]);
  });
});
