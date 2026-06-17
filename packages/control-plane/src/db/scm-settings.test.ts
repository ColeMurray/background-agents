import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScmGlobalConfig, ScmSettings } from "@open-inspect/shared";
import { ScmSettingsStore, ScmSettingsValidationError } from "./scm-settings";
import { IntegrationSettingsStore } from "./integration-settings";

// ScmSettingsStore is a thin wrapper over IntegrationSettingsStore pinned to the
// "scm" key. We mock the underlying store so these tests cover only the wrapper's
// responsibilities — key pinning, validation, and resolved-settings extraction —
// without touching SQL (the storage behavior is covered by integration-settings.test.ts).
const { delegate } = vi.hoisted(() => ({
  delegate: {
    getGlobal: vi.fn(),
    setGlobal: vi.fn(),
    deleteGlobal: vi.fn(),
    getRepoSettings: vi.fn(),
    setRepoSettings: vi.fn(),
    deleteRepoSettings: vi.fn(),
    listRepoSettings: vi.fn(),
    getResolvedConfig: vi.fn(),
  },
}));

vi.mock("./integration-settings", () => ({
  IntegrationSettingsStore: vi.fn(function () {
    return delegate;
  }),
}));

describe("ScmSettingsStore", () => {
  let store: ScmSettingsStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ScmSettingsStore({} as unknown as D1Database);
  });

  it("delegates getGlobal to the 'scm' key", async () => {
    delegate.getGlobal.mockResolvedValue({ defaults: { alwaysUseDraftMode: true } });
    const result = await store.getGlobal();
    expect(delegate.getGlobal).toHaveBeenCalledWith("scm");
    expect(result).toEqual({ defaults: { alwaysUseDraftMode: true } });
  });

  it("delegates setGlobal to the 'scm' key", async () => {
    await store.setGlobal({ defaults: { alwaysUseDraftMode: true } });
    expect(delegate.setGlobal).toHaveBeenCalledWith("scm", {
      defaults: { alwaysUseDraftMode: true },
    });
  });

  it("delegates per-repo reads, writes, lists, and deletes to the 'scm' key", async () => {
    delegate.getRepoSettings.mockResolvedValue({ alwaysUseDraftMode: false });
    delegate.listRepoSettings.mockResolvedValue([
      { repo: "acme/web", settings: { alwaysUseDraftMode: true } },
    ]);

    await store.setRepoSettings("Acme/Web", { alwaysUseDraftMode: true });
    const repoSettings = await store.getRepoSettings("acme/web");
    const list = await store.listRepoSettings();
    await store.deleteRepoSettings("acme/web");
    await store.deleteGlobal();

    expect(delegate.setRepoSettings).toHaveBeenCalledWith("scm", "Acme/Web", {
      alwaysUseDraftMode: true,
    });
    expect(delegate.getRepoSettings).toHaveBeenCalledWith("scm", "acme/web");
    expect(repoSettings).toEqual({ alwaysUseDraftMode: false });
    expect(list).toHaveLength(1);
    expect(delegate.deleteRepoSettings).toHaveBeenCalledWith("scm", "acme/web");
    expect(delegate.deleteGlobal).toHaveBeenCalledWith("scm");
  });

  it("rejects a non-boolean alwaysUseDraftMode and does not write", async () => {
    await expect(
      store.setGlobal({ defaults: { alwaysUseDraftMode: "yes" as unknown as boolean } })
    ).rejects.toThrow(ScmSettingsValidationError);
    await expect(
      store.setRepoSettings("acme/web", { alwaysUseDraftMode: 1 as unknown as boolean })
    ).rejects.toThrow(ScmSettingsValidationError);

    expect(delegate.setGlobal).not.toHaveBeenCalled();
    expect(delegate.setRepoSettings).not.toHaveBeenCalled();
  });

  it("rejects unknown keys and unsupported global config and does not write", async () => {
    await expect(
      store.setRepoSettings("acme/web", { unexpected: true } as unknown as ScmSettings)
    ).rejects.toThrow(ScmSettingsValidationError);
    // `enabledRepos` (and any non-`defaults` global key) is not supported for scm.
    await expect(
      store.setGlobal({ enabledRepos: ["acme/web"] } as unknown as ScmGlobalConfig)
    ).rejects.toThrow(ScmSettingsValidationError);
    // Arrays are not valid settings objects.
    await expect(store.setGlobal([] as unknown as ScmGlobalConfig)).rejects.toThrow(
      ScmSettingsValidationError
    );

    expect(delegate.setGlobal).not.toHaveBeenCalled();
    expect(delegate.setRepoSettings).not.toHaveBeenCalled();
  });

  it("resolves a repo's effective settings from the underlying merged config", async () => {
    delegate.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { alwaysUseDraftMode: false },
    });

    const resolved = await store.getResolvedSettings("acme/web");

    expect(delegate.getResolvedConfig).toHaveBeenCalledWith("scm", "acme/web");
    expect(resolved).toEqual({ alwaysUseDraftMode: false });
  });

  it("constructs the underlying IntegrationSettingsStore", () => {
    expect(IntegrationSettingsStore).toHaveBeenCalled();
  });
});
