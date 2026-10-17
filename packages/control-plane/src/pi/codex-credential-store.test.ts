import { describe, expect, it, vi } from "vitest";
import { CodexBrokerCredentialStore } from "./codex-credential-store";

describe("CodexBrokerCredentialStore", () => {
  it("maps the session broker response to an in-memory Pi OAuth credential", async () => {
    const fetchCredential = vi.fn(async () => ({
      accessToken: "access.jwt.token",
      expiresIn: 3_600,
    }));
    const store = new CodexBrokerCredentialStore(fetchCredential, () => 1_000_000);

    await expect(store.read("openai-codex")).resolves.toEqual({
      type: "oauth",
      access: "access.jwt.token",
      refresh: "managed-by-open-inspect",
      expires: 4_600_000,
    });
    await expect(store.list()).resolves.toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("never offers the credential to another Pi provider", async () => {
    const fetchCredential = vi.fn(async () => ({ accessToken: "token", expiresIn: 60 }));
    const store = new CodexBrokerCredentialStore(fetchCredential);

    await expect(store.read("openai")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
    expect(fetchCredential).not.toHaveBeenCalled();
  });

  it("single-flights concurrent broker reads and replaces generic OAuth refreshes through the broker", async () => {
    let release!: (value: { accessToken: string; expiresIn: number }) => void;
    const fetchCredential = vi.fn(
      () =>
        new Promise<{ accessToken: string; expiresIn: number }>((resolve) => {
          release = resolve;
        })
    );
    const store = new CodexBrokerCredentialStore(fetchCredential, () => 1_000);

    const first = store.read("openai-codex");
    const second = store.read("openai-codex");
    release({ accessToken: "token", expiresIn: 120 });

    expect(await first).toEqual(await second);
    expect(fetchCredential).toHaveBeenCalledOnce();
    const genericRefresh = vi.fn(async () => ({
      type: "oauth" as const,
      access: "must-not-use",
      refresh: "must-not-use",
      expires: 999_999,
    }));
    const refreshed = store.modify("openai-codex", genericRefresh);
    release({ accessToken: "broker-refreshed", expiresIn: 120 });
    await expect(refreshed).resolves.toMatchObject({ access: "broker-refreshed" });
    expect(genericRefresh).not.toHaveBeenCalled();
    await expect(store.read("openai-codex")).resolves.toMatchObject({ access: "broker-refreshed" });
  });

  it("does not allow logout to turn broker denial into an API-key fallback", async () => {
    const fetchCredential = vi.fn(async () => {
      throw new Error("account disabled");
    });
    const store = new CodexBrokerCredentialStore(fetchCredential);

    await store.delete("openai-codex");
    await expect(store.read("openai-codex")).rejects.toThrow("account disabled");
  });

  it("does not let an invalidated broker request clear a newer in-flight request", async () => {
    const releases: Array<(value: { accessToken: string; expiresIn: number }) => void> = [];
    const fetchCredential = vi.fn(
      () =>
        new Promise<{ accessToken: string; expiresIn: number }>((resolve) => {
          releases.push(resolve);
        })
    );
    const store = new CodexBrokerCredentialStore(fetchCredential);

    const stale = store.read("openai-codex");
    store.clear();
    const current = store.read("openai-codex");
    releases[0]?.({ accessToken: "stale", expiresIn: 60 });
    await expect(stale).rejects.toThrow("invalidated");
    const joined = store.read("openai-codex");
    expect(fetchCredential).toHaveBeenCalledTimes(2);
    releases[1]?.({ accessToken: "current", expiresIn: 60 });
    await expect(current).resolves.toMatchObject({ access: "current" });
    await expect(joined).resolves.toMatchObject({ access: "current" });
  });
});
