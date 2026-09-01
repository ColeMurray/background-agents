import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore, normalizeBaseUrl } from "./config-store.js";
import {
  type CredentialStore,
  createNativeCredentialBackend,
  FileCredentialStore,
  type NativeCredentialBackend,
  isUnavailableNativeModule,
  selectCredentialStore,
} from "./credential-store.js";

const credential = `oi_cli_${"a".repeat(64)}`;
const rotatedCredential = `oi_cli_${"b".repeat(64)}`;

function memoryStore(): CredentialStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    kind: "native",
    values,
    get: async (reference) => values.get(reference),
    set: async (reference, value) => void values.set(reference, value),
    delete: async (reference) => void values.delete(reference),
  };
}

describe("ConfigStore", () => {
  it("separates reference metadata from fallback credentials and secures POSIX files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory);
    await store.saveContext("work", {
      url: "https://work.example.com",
      credential,
      expiresAt: 10,
    });
    await store.saveContext("local", {
      url: "http://localhost:8787",
      credential: rotatedCredential,
      expiresAt: 20,
    });
    await store.setActiveContext("work");

    expect(await store.getActiveContext()).toMatchObject({ name: "work", credential });
    expect(Object.keys((await store.read()).contexts)).toEqual(["work", "local"]);
    const metadata = await readFile(store.filePath, "utf8");
    expect(metadata).not.toContain(credential);
    expect(metadata).toContain("credentialRef");
    expect(await readFile(join(directory, "credentials.json"), "utf8")).toContain(credential);
    if (process.platform !== "win32") {
      expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "credentials.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("rotates through immutable references before deleting the old secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const credentials = memoryStore();
    const references = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    const store = new ConfigStore(directory, {
      credentialStore: credentials,
      generateCredentialRef: () => references.shift()!,
    });
    await store.saveContext("work", {
      url: "https://old.example.com",
      credential,
      expiresAt: 10,
    });
    await store.saveContext("work", {
      url: "https://new.example.com",
      credential: rotatedCredential,
      expiresAt: 20,
    });

    expect(await store.getActiveContext()).toMatchObject({
      url: "https://new.example.com",
      credential: rotatedCredential,
    });
    expect([...credentials.values]).toEqual([[referencesForTest(2), rotatedCredential]]);
  });

  it("retains the old URL/reference pair when writing a rotated secret fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const credentials = memoryStore();
    const set = vi.spyOn(credentials, "set");
    const references = [referencesForTest(1), referencesForTest(2)];
    const store = new ConfigStore(directory, {
      credentialStore: credentials,
      generateCredentialRef: () => references.shift()!,
    });
    await store.saveContext("work", {
      url: "https://old.example.com",
      credential,
      expiresAt: 10,
    });
    set.mockRejectedValueOnce(new Error("keychain locked"));

    await expect(
      store.saveContext("work", {
        url: "https://new.example.com",
        credential: rotatedCredential,
        expiresAt: 20,
      })
    ).rejects.toThrow("keychain locked");
    expect(await store.getActiveContext()).toMatchObject({
      url: "https://old.example.com",
      credential,
    });
    expect([...credentials.values]).toEqual([[referencesForTest(1), credential]]);
  });

  it("restores the complete old pair when old-secret cleanup fails after rotation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const credentials = memoryStore();
    const references = [referencesForTest(1), referencesForTest(2)];
    const store = new ConfigStore(directory, {
      credentialStore: credentials,
      generateCredentialRef: () => references.shift()!,
    });
    await store.saveContext("work", {
      url: "https://old.example.com",
      credential,
      expiresAt: 10,
    });
    vi.spyOn(credentials, "delete").mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(
      store.saveContext("work", {
        url: "https://new.example.com",
        credential: rotatedCredential,
        expiresAt: 20,
      })
    ).rejects.toThrow("cleanup failed");
    expect(await store.getActiveContext()).toMatchObject({
      url: "https://old.example.com",
      credential,
    });
    expect([...credentials.values]).toEqual([[referencesForTest(1), credential]]);
  });

  it("does not remove metadata when credential deletion fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const credentials = memoryStore();
    const store = new ConfigStore(directory, { credentialStore: credentials });
    await store.saveContext("work", {
      url: "https://work.example.com",
      credential,
      expiresAt: 10,
    });
    vi.spyOn(credentials, "delete").mockRejectedValueOnce(new Error("keychain locked"));

    await expect(store.removeActiveContext()).rejects.toThrow("keychain locked");
    expect((await store.read()).activeContext).toBe("work");
    expect(await store.getActiveContext()).toMatchObject({ credential });
  });

  it("restores a deleted credential when logout metadata removal loses a concurrency race", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const credentials = memoryStore();
    const store = new ConfigStore(directory, { credentialStore: credentials });
    await store.saveContext("work", {
      url: "https://old.example.com",
      credential,
      expiresAt: 10,
    });
    const current = await store.read();
    const oldReference = current.contexts.work!.credentialRef;
    const concurrentReference = referencesForTest(99);
    credentials.values.set(concurrentReference, rotatedCredential);
    vi.spyOn(credentials, "delete").mockImplementationOnce(async (reference) => {
      credentials.values.delete(reference);
      await writeFile(
        store.filePath,
        `${JSON.stringify({
          activeContext: "work",
          contexts: {
            work: {
              url: "https://new.example.com",
              expiresAt: 20,
              credentialRef: concurrentReference,
            },
          },
        })}\n`
      );
    });

    await expect(store.removeActiveContext()).rejects.toThrow("Context changed");
    expect(credentials.values.get(oldReference)).toBe(credential);
    expect(await store.getActiveContext()).toMatchObject({
      url: "https://new.example.com",
      credential: rotatedCredential,
    });
  });

  it("repairs permissive POSIX modes and uses unique atomic temporary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const store = new ConfigStore(directory);
    await store.saveContext("default", {
      url: "https://example.com",
      credential,
      expiresAt: 10,
    });
    if (process.platform !== "win32") {
      await chmod(store.filePath, 0o644);
      await store.read();
      expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    }
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes concurrent context updates without losing entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        new ConfigStore(directory).saveContext(`context-${index}`, {
          url: `https://host-${index}.example.com`,
          credential: `oi_cli_${String(index).padStart(64, "a")}`,
          expiresAt: index,
        })
      )
    );
    expect(Object.keys((await new ConfigStore(directory).read()).contexts)).toHaveLength(20);
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects reserved context name %s at save and selection boundaries",
    async (name) => {
      const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
      const store = new ConfigStore(directory);

      await expect(
        store.saveContext(name, {
          url: "https://example.com",
          credential,
          expiresAt: 10,
        })
      ).rejects.toMatchObject({ kind: "validation" });
      await expect(store.setActiveContext(name)).rejects.toMatchObject({ kind: "validation" });
      expect((await store.read()).contexts).toEqual({});
    }
  );
});

describe("credential backend selection", () => {
  it("returns the keyring deletion promise so deferred failures reach rollback callers", async () => {
    let rejectDelete!: (cause: Error) => void;
    class DeferredEntry {
      getPassword() {
        return null;
      }
      setPassword() {}
      deletePassword() {
        return new Promise<boolean>((_resolve, reject) => {
          rejectDelete = reject;
        });
      }
    }
    const backend = createNativeCredentialBackend(DeferredEntry);
    const deletion = Promise.resolve(backend.deletePassword("service", "account"));

    await expect(
      Promise.race([deletion.then(() => "settled"), Promise.resolve("pending")])
    ).resolves.toBe("pending");
    rejectDelete(new Error("deferred keyring failure"));
    await expect(deletion).rejects.toThrow("deferred keyring failure");
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "selects injected native storage on %s and namespaces records by profile/reference",
    async (platform) => {
      const backend: NativeCredentialBackend = {
        getPassword: vi.fn().mockReturnValue(credential),
        setPassword: vi.fn(),
        deletePassword: vi.fn(),
      };
      const store = await selectCredentialStore("/unused", {
        platform,
        profile: "profile-a",
        nativeBackend: backend,
      });
      await store.set("reference-a", credential);
      await store.get("reference-a");
      expect(backend.setPassword).toHaveBeenCalledWith(
        "open-inspect-cli",
        "profile-a:reference-a",
        credential
      );
      expect(store.kind).toBe("native");
    }
  );

  it("uses secure file fallback only when native storage is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const backend = await selectCredentialStore(directory, {
      platform: "linux",
      loadNativeBackend: vi.fn().mockResolvedValue(undefined),
    });
    expect(backend).toBeInstanceOf(FileCredentialStore);
  });

  it("recognizes the keyring plain Error-with-cause load failure shape", () => {
    expect(
      isUnavailableNativeModule(
        new Error("Cannot find native binding. npm optional dependency is missing.", {
          cause: new Error("incompatible binary"),
        })
      )
    ).toBe(true);
    expect(
      isUnavailableNativeModule(new Error("credential manager locked", { cause: new Error("I/O") }))
    ).toBe(false);
    expect(isUnavailableNativeModule(new Error("Failed to load native binding"))).toBe(true);
    expect(isUnavailableNativeModule(new Error("Cannot find native binding."))).toBe(false);
  });

  it("falls back for binding load failures but propagates arbitrary loader errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const unavailable = new Error(
      "Cannot find native binding. npm optional dependency is missing.",
      {
        cause: new Error("missing platform package"),
      }
    );

    await expect(
      selectCredentialStore(directory, {
        platform: "linux",
        loadNativeBackend: vi.fn().mockRejectedValue(unavailable),
      })
    ).resolves.toBeInstanceOf(FileCredentialStore);
    await expect(
      selectCredentialStore(directory, {
        platform: "linux",
        loadNativeBackend: vi.fn().mockRejectedValue(new Error("keyring runtime failure")),
      })
    ).rejects.toThrow("keyring runtime failure");
  });

  it("does not copy secrets to fallback after a native backend operation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oi-cli-test-"));
    const backend = await selectCredentialStore(directory, {
      platform: "win32",
      nativeBackend: {
        getPassword: vi.fn(),
        setPassword: vi.fn().mockRejectedValue(new Error("credential manager locked")),
        deletePassword: vi.fn(),
      },
    });
    await expect(backend.set("reference", credential)).rejects.toThrow("locked");
    await expect(
      new FileCredentialStore(join(directory, "credentials.json")).get("reference")
    ).resolves.toBeUndefined();
  });
});

describe("normalizeBaseUrl", () => {
  it.each(["http://localhost:8787/", "http://127.0.0.1:8787", "http://[::1]:8787"])(
    "permits loopback HTTP URL %s",
    (url) => expect(normalizeBaseUrl(url)).toMatch(/^http:/)
  );

  it.each([
    "http://example.com",
    "http://0.0.0.0:8787",
    "ftp://localhost",
    "https://user:pass@example.com",
    "https://example.com?tenant=x",
    "https://example.com#fragment",
    "https://example.com/prefix",
  ])("rejects unsafe or ambiguous base URL %s", (url) =>
    expect(() => normalizeBaseUrl(url)).toThrow()
  );
});

function referencesForTest(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
