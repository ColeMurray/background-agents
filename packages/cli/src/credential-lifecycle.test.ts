import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { updateJsonFile } from "./atomic-json-file.js";
import { CredentialLifecycle } from "./credential-lifecycle.js";
import {
  type ConfigFileUpdater,
  ConfigStore,
  credentialReference,
  deviceAuthorizationReference,
} from "./config-store.js";
import { FileCredentialStore, type CredentialStore } from "./credential-store.js";

const oldCredential = `oi_cli_${"a".repeat(64)}`;
const newCredential = `oi_cli_${"b".repeat(64)}`;
const thirdCredential = `oi_cli_${"c".repeat(64)}`;
const deviceSecret = "d".repeat(64);

function issued(
  url = "https://new.example.com",
  credential = newCredential,
  credentialId = "new-credential"
) {
  return { url, credential, credentialId, expiresAt: 20 };
}

function memoryStore(): CredentialStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    kind: "native",
    values,
    get: async (reference) => values.get(reference),
    set: async (reference, credential) => void values.set(reference, credential),
    delete: async (reference) => void values.delete(reference),
  };
}

async function seedOldContext(directory: string): Promise<void> {
  await new ConfigStore(directory).saveContext("work", {
    url: "https://old.example.com",
    credential: oldCredential,
    expiresAt: 10,
  });
}

async function install(
  store: ConfigStore,
  lifecycle: CredentialLifecycle,
  name = "work",
  context = issued()
) {
  const deviceSecretRef = await lifecycle.stageDeviceAuthorization({
    url: context.url,
    contextName: name,
    deviceSecret,
  });
  return lifecycle.install(name, context, deviceSecretRef);
}

describe("CredentialLifecycle", () => {
  it("rolls back the device secret when authorization metadata persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory, {
      updateConfigFile: vi.fn<ConfigFileUpdater>().mockRejectedValue(new Error("disk full")),
    });

    await expect(
      store.stageDeviceAuthorization({
        url: "https://new.example.com",
        contextName: "work",
        deviceSecret,
      })
    ).rejects.toThrow("disk full");
    await expect(
      new FileCredentialStore(join(directory, "credentials.json")).get(
        deviceAuthorizationReference(deviceSecret)
      )
    ).resolves.toBeUndefined();
  });

  it("promotes the new binding before revoking the old credential against its old URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    await seedOldContext(directory);
    const store = new ConfigStore(directory);
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (request, init) => {
      await expect(store.getActiveContext()).resolves.toMatchObject({
        url: "https://new.example.com",
        credential: newCredential,
      });
      expect(String(request)).toBe("https://old.example.com/external/v1/cli/credentials/current");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${oldCredential}`);
      return new Response(null, { status: 204 });
    });

    await expect(install(store, new CredentialLifecycle(store, fetch))).resolves.toEqual({
      pendingRevocations: 0,
      pendingDeviceAuthorizations: 0,
    });
    expect((await store.read()).pendingRevocations).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable deterministic reference when secret staging fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const credentials = memoryStore();
    const store = new ConfigStore(directory, { credentialStore: credentials });
    const lifecycle = new CredentialLifecycle(
      store,
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    );
    const deviceSecretRef = await lifecycle.stageDeviceAuthorization({
      url: "https://new.example.com",
      contextName: "work",
      deviceSecret,
    });
    vi.spyOn(credentials, "set").mockRejectedValueOnce(new Error("keyring locked"));
    const error = await lifecycle
      .install("work", issued(), deviceSecretRef)
      .catch((cause) => cause);

    expect(error).toMatchObject({
      kind: "service",
      context: {
        credentialId: "new-credential",
        credentialRef: credentialReference("new-credential"),
      },
    });
    expect(await store.read()).toMatchObject({ activeContext: null, pendingRevocations: [] });
  });

  it("retains the deterministic secret when staging metadata fails and recovers on retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const failingUpdate = vi
      .fn<ConfigFileUpdater>()
      .mockImplementation(updateJsonFile)
      .mockImplementationOnce(updateJsonFile)
      .mockRejectedValueOnce(new Error("disk full"));
    const store = new ConfigStore(directory, { updateConfigFile: failingUpdate });
    const lifecycle = new CredentialLifecycle(
      store,
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    );
    const error = await install(store, lifecycle).catch((cause) => cause);
    const reference = credentialReference("new-credential");

    expect(error).toMatchObject({
      kind: "service",
      context: { credentialId: "new-credential", credentialRef: reference },
    });
    await expect(
      new FileCredentialStore(join(directory, "credentials.json")).get(reference)
    ).resolves.toBe(newCredential);

    const restarted = new ConfigStore(directory);
    await expect(install(restarted, new CredentialLifecycle(restarted, vi.fn()))).resolves.toEqual({
      pendingRevocations: 0,
      pendingDeviceAuthorizations: 0,
    });
    await expect(restarted.getActiveContext()).resolves.toMatchObject({
      credential: newCredential,
    });
  });

  it("retains both recovery handles when promotion storage and network revocation fail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    await seedOldContext(directory);
    const update = vi
      .fn<ConfigFileUpdater>()
      .mockImplementation(updateJsonFile)
      .mockImplementationOnce(updateJsonFile)
      .mockImplementationOnce(updateJsonFile)
      .mockRejectedValueOnce(new Error("binding write failed"));
    const store = new ConfigStore(directory, { updateConfigFile: update });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 }));

    const failure = await install(store, new CredentialLifecycle(store, fetch)).catch(
      (cause) => cause
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toMatchObject({
      context: {
        credentialId: "new-credential",
        credentialRef: credentialReference("new-credential"),
      },
    });
    expect((await store.read()).pendingRevocations).toMatchObject([
      { credentialId: "new-credential", purpose: "staged" },
    ]);
    expect((await store.read()).pendingDeviceAuthorizations).toMatchObject([{ state: "recovery" }]);
    await expect(store.getActiveContext()).resolves.toMatchObject({ credential: oldCredential });

    const restarted = new ConfigStore(directory);
    const restartedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      new CredentialLifecycle(restarted, restartedFetch).logout()
    ).resolves.toMatchObject({
      name: "work",
    });
    expect(restartedFetch).toHaveBeenCalledTimes(3);
    expect(String(restartedFetch.mock.calls[0]?.[0])).toBe(
      "https://new.example.com/external/v1/cli/device-authorizations/revoke"
    );
    expect(new Headers(restartedFetch.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(
      false
    );
    expect((await restarted.read()).pendingRevocations).toEqual([]);
  });

  it("never capability-revokes after promotion when device-secret cleanup fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const credentials = memoryStore();
    const store = new ConfigStore(directory, { credentialStore: credentials });
    const lifecycle = new CredentialLifecycle(store, vi.fn());
    const deviceSecretRef = await lifecycle.stageDeviceAuthorization({
      url: "https://new.example.com",
      contextName: "work",
      deviceSecret,
    });
    vi.spyOn(credentials, "delete").mockImplementation(async (reference) => {
      if (reference === deviceSecretRef) throw new Error("keyring locked");
      credentials.values.delete(reference);
    });

    await expect(lifecycle.install("work", issued(), deviceSecretRef)).resolves.toEqual({
      pendingRevocations: 0,
      pendingDeviceAuthorizations: 1,
    });
    expect((await store.read()).pendingDeviceAuthorizations).toMatchObject([
      { deviceSecretRef, state: "cleanup" },
    ]);
    await expect(store.getActiveContext()).resolves.toMatchObject({ credential: newCredential });
  });

  it("removes the staged marker on promotion but retains a failed old revocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    await seedOldContext(directory);
    const store = new ConfigStore(directory);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 }));

    await expect(install(store, new CredentialLifecycle(store, fetch))).resolves.toEqual({
      pendingRevocations: 1,
      pendingDeviceAuthorizations: 0,
    });
    expect((await store.read()).pendingRevocations).toMatchObject([
      { url: "https://old.example.com", purpose: "replaced" },
    ]);
    expect((await store.read()).pendingRevocations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ purpose: "staged" })])
    );
  });

  it("login retries persisted revocations after a process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    await seedOldContext(directory);
    const initial = new ConfigStore(directory);
    await install(
      initial,
      new CredentialLifecycle(
        initial,
        vi.fn().mockResolvedValue(Response.json({ error: "retry" }, { status: 429 }))
      )
    );

    const restarted = new ConfigStore(directory);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      install(
        restarted,
        new CredentialLifecycle(restarted, fetch),
        "other",
        issued("https://third.example.com", thirdCredential, "third-credential")
      )
    ).resolves.toEqual({ pendingRevocations: 0, pendingDeviceAuthorizations: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await restarted.read()).pendingRevocations).toEqual([]);
  });

  it("login startup capability-recovers a persisted device authorization after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const initial = new ConfigStore(directory);
    await initial.stageDeviceAuthorization({
      url: "https://new.example.com",
      contextName: "work",
      deviceSecret,
    });
    const restarted = new ConfigStore(directory);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await new CredentialLifecycle(restarted, fetch).prepareLogin();

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://new.example.com/external/v1/cli/device-authorizations/revoke"
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
    expect((await restarted.read()).pendingDeviceAuthorizations).toEqual([]);
  });

  it("logout drains pending and active credentials before removing the context", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    await seedOldContext(directory);
    const initial = new ConfigStore(directory);
    await install(
      initial,
      new CredentialLifecycle(
        initial,
        vi.fn().mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 }))
      )
    );
    const restarted = new ConfigStore(directory);
    const seen: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_request, init) => {
      seen.push(new Headers(init?.headers).get("Authorization") ?? "");
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    await new CredentialLifecycle(restarted, fetch).logout();

    expect(seen).toEqual([`Bearer ${oldCredential}`, `Bearer ${newCredential}`]);
    expect((await restarted.read()).pendingRevocations).toEqual([]);
    await expect(restarted.getActiveContext()).rejects.toThrow("Not logged in");
  });

  it("logout drains a staged credential even when no active context exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    await new ConfigStore(directory).stageCredential(issued());
    const restarted = new ConfigStore(directory);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(new CredentialLifecycle(restarted, fetch).logout()).rejects.toThrow(
      "Not logged in"
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await restarted.read()).pendingRevocations).toEqual([]);
  });

  it("logout fails and preserves pending and active handles on transient errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    await seedOldContext(directory);
    const initial = new ConfigStore(directory);
    await install(
      initial,
      new CredentialLifecycle(
        initial,
        vi.fn().mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 }))
      )
    );
    const restarted = new ConfigStore(directory);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(Response.json({ error: "limited" }, { status: 429 }));

    await expect(new CredentialLifecycle(restarted, fetch).logout()).rejects.toBeInstanceOf(
      AggregateError
    );
    expect(await restarted.getPendingRevocations()).toMatchObject([{ credential: oldCredential }]);
    await expect(restarted.getActiveContext()).resolves.toMatchObject({
      credential: newCredential,
    });
  });

  it("logout clears definitive-invalid pending and active handles after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    await seedOldContext(directory);
    const initial = new ConfigStore(directory);
    await install(
      initial,
      new CredentialLifecycle(
        initial,
        vi.fn().mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 }))
      )
    );
    const restarted = new ConfigStore(directory);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: "gone" }, { status: 410 }))
      .mockResolvedValueOnce(Response.json({ error: "invalid" }, { status: 401 }));

    await expect(new CredentialLifecycle(restarted, fetch).logout()).resolves.toMatchObject({
      name: "work",
    });
    expect((await restarted.read()).pendingRevocations).toEqual([]);
    await expect(restarted.getActiveContext()).rejects.toThrow("Not logged in");
  });

  it("restores a pending secret when marker cleanup persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    await seedOldContext(directory);
    const initial = new ConfigStore(directory);
    await install(
      initial,
      new CredentialLifecycle(
        initial,
        vi.fn().mockResolvedValue(Response.json({ error: "unavailable" }, { status: 503 }))
      )
    );
    const failingUpdate = vi
      .fn<ConfigFileUpdater>()
      .mockRejectedValue(new Error("configuration locked"));
    const store = new ConfigStore(directory, { updateConfigFile: failingUpdate });
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(new CredentialLifecycle(store, fetch).logout()).rejects.toThrow(
      "configuration locked"
    );

    const restarted = new ConfigStore(directory);
    await expect(restarted.getPendingRevocations()).resolves.toMatchObject([
      { credential: oldCredential },
    ]);
    await expect(restarted.getActiveContext()).resolves.toMatchObject({
      credential: newCredential,
    });
  });

  it("retains the pending marker when local cleanup fails after remote revocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const credentials = memoryStore();
    const store = new ConfigStore(directory, { credentialStore: credentials });
    await store.saveContext("work", {
      url: "https://old.example.com",
      credential: oldCredential,
      expiresAt: 10,
    });
    const oldReference = (await store.read()).contexts.work!.credentialRef;
    vi.spyOn(credentials, "delete").mockImplementation(async (reference) => {
      if (reference === oldReference) throw new Error("keyring locked");
      credentials.values.delete(reference);
    });

    await expect(
      install(
        store,
        new CredentialLifecycle(
          store,
          vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
        )
      )
    ).resolves.toEqual({ pendingRevocations: 1, pendingDeviceAuthorizations: 0 });
    expect(await store.getPendingRevocations()).toMatchObject([{ credential: oldCredential }]);
  });
});
