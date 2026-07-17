import { beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";

import { generateInternalToken } from "../../src/auth/internal";
import { CommitSigningStore } from "../../src/db/commit-signing";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth } from "./helpers";

const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6QAAAKAVa6SnFWuk
pwAAAAtzc2gtZWQyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6Q
AAAEDu3j73XlXgmmJ6DeqA0/0I1EGPhOmMnk/be7rZrpUxDBaM0ggz8RWOz0lq3xs+vNPv
nuWs0SS30txpSJTb357pAAAAGXRlc3Qtc2lnbmluZ0BvcGVuLWluc3BlY3QBAgME
-----END OPENSSH PRIVATE KEY-----`;
type StoredConfiguration = Parameters<CommitSigningStore["save"]>[0];

const STORED_CONFIGURATION: StoredConfiguration = {
  privateKey: PRIVATE_KEY,
  githubLogin: "open-inspect-bot",
  committerName: "Open Inspect",
  committerEmail: "open-inspect@example.com",
  keyFormat: "ssh-ed25519",
  publicKey: "ssh-ed25519 AAAA test",
  fingerprint: "SHA256:test",
  validatedAt: 1_721_152_000_000,
};

const WRITE_REQUEST = {
  privateKey: PRIVATE_KEY,
  githubLogin: "open-inspect-bot",
  committerName: "Open Inspect",
  committerEmail: "open-inspect@example.com",
};

function createStore(): CommitSigningStore {
  return new CommitSigningStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
}

async function saveConfiguration(
  overrides: Partial<StoredConfiguration> = {}
): Promise<CommitSigningStore> {
  const store = createStore();
  await store.save({ ...STORED_CONFIGURATION, ...overrides });
  return store;
}

async function createSandboxSession(
  prefix: string,
  authToken = "sandbox-token",
  sandboxId = "sandbox-1"
): Promise<string> {
  const sessionName = `${prefix}-${Date.now()}`;
  const { stub } = await initNamedSession(sessionName);
  await seedSandboxAuth(stub, { authToken, sandboxId });
  return sessionName;
}

describe("commit signing store", () => {
  beforeEach(cleanD1Tables);

  it("stores ciphertext while returning metadata without the private key", async () => {
    const store = await saveConfiguration();

    const stored = await env.DB.prepare(
      "SELECT encrypted_private_key FROM commit_signing_configuration WHERE singleton_id = 1"
    ).first<{ encrypted_private_key: string }>();
    expect(stored?.encrypted_private_key).toBeTruthy();
    expect(stored?.encrypted_private_key).not.toContain("OPENSSH PRIVATE KEY");
    expect(await store.getMetadata()).toEqual(
      expect.objectContaining({
        enabled: true,
        githubLogin: "open-inspect-bot",
        fingerprint: "SHA256:test",
      })
    );
  });

  it("decrypts the exact key only through the broker-facing method", async () => {
    const store = await saveConfiguration();

    expect(await store.getDecryptedConfiguration()).toEqual(
      expect.objectContaining({ enabled: true, privateKey: PRIVATE_KEY })
    );
  });

  it("leaves an active row unchanged when encryption fails", async () => {
    await saveConfiguration();
    const before = await env.DB.prepare(
      "SELECT * FROM commit_signing_configuration WHERE singleton_id = 1"
    ).first();

    await expect(
      new CommitSigningStore(env.DB, "not-base64").save({
        ...STORED_CONFIGURATION,
        githubLogin: "replacement",
      })
    ).rejects.toThrow();

    expect(
      await env.DB.prepare(
        "SELECT * FROM commit_signing_configuration WHERE singleton_id = 1"
      ).first()
    ).toEqual(before);
  });

  it("returns the fingerprint from the row deleted by the same mutation", async () => {
    const store = await saveConfiguration({ fingerprint: "SHA256:deleted" });

    expect(await store.delete()).toBe("SHA256:deleted");
    expect(await store.delete()).toBeUndefined();
  });
});

describe("commit signing settings API", () => {
  beforeEach(cleanD1Tables);

  it("returns disabled metadata with no-store when no key is configured", async () => {
    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
    const response = await SELF.fetch("https://test.local/commit-signing", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ enabled: false });
  });

  it("validates and stores a key while returning public metadata only", async () => {
    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
    const response = await SELF.fetch("https://test.local/commit-signing", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(WRITE_REQUEST),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual(
      expect.objectContaining({
        enabled: true,
        keyFormat: "ssh-ed25519",
        githubLogin: "open-inspect-bot",
        publicKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBaM0ggz8RWOz0lq3xs+vNPvnuWs0SS30txpSJTb357p",
        fingerprint: "SHA256:Cu64KulDfH7B8Mu37+JWepAJ1m59o159Y8RPj5Ta1XM",
        validationStatus: "valid",
      })
    );
    expect(JSON.stringify(body)).not.toContain("OPENSSH PRIVATE KEY");
  });

  it("deletes the active ciphertext when signing is disabled", async () => {
    await saveConfiguration({ validatedAt: Date.now() });
    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);

    const response = await SELF.fetch("https://test.local/commit-signing", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ enabled: false });
    expect(await env.DB.prepare("SELECT 1 FROM commit_signing_configuration").first()).toBeNull();
  });

  it("atomically replaces configuration while preserving created_at", async () => {
    await saveConfiguration({
      githubLogin: "old-login",
      committerName: "Old Name",
      committerEmail: "old@example.com",
      publicKey: "ssh-ed25519 AAAA old",
      fingerprint: "SHA256:old",
      validatedAt: 1,
    });
    await env.DB.prepare(
      "UPDATE commit_signing_configuration SET created_at = 1, updated_at = 1 WHERE singleton_id = 1"
    ).run();
    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);

    const response = await SELF.fetch("https://test.local/commit-signing", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privateKey: PRIVATE_KEY,
        githubLogin: "new-login",
        committerName: "New Name",
        committerEmail: "new@example.com",
      }),
    });

    expect(response.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT github_login, created_at, updated_at, validated_at FROM commit_signing_configuration WHERE singleton_id = 1"
    ).first<{
      github_login: string;
      created_at: number;
      updated_at: number;
      validated_at: number;
    }>();
    expect(row?.github_login).toBe("new-login");
    expect(row?.created_at).toBe(1);
    expect(row?.updated_at).toBeGreaterThan(1);
    expect(row?.validated_at).toBeGreaterThan(1);
  });

  it("leaves the active row unchanged after validation failure and redacts the response", async () => {
    await saveConfiguration({
      githubLogin: "old-login",
      committerName: "Old Name",
      committerEmail: "old@example.com",
      publicKey: "ssh-ed25519 AAAA old",
      fingerprint: "SHA256:old",
      validatedAt: 1,
    });
    const before = await env.DB.prepare(
      "SELECT * FROM commit_signing_configuration WHERE singleton_id = 1"
    ).first();
    const submittedKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-bytes\n";
    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);

    const response = await SELF.fetch("https://test.local/commit-signing", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        privateKey: submittedKey,
        githubLogin: "new-login",
        committerName: "New Name",
        committerEmail: "new@example.com",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(submittedKey);
    expect(
      await env.DB.prepare(
        "SELECT * FROM commit_signing_configuration WHERE singleton_id = 1"
      ).first()
    ).toEqual(before);
  });

  it.each(["GET", "PUT", "DELETE"])("rejects unauthenticated %s requests", async (method) => {
    const response = await SELF.fetch("https://test.local/commit-signing", {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "PUT" ? JSON.stringify(WRITE_REQUEST) : undefined,
    });

    expect(response.status).toBe(401);
  });
});

describe("sandbox commit signing broker", () => {
  beforeEach(cleanD1Tables);

  it("rejects a valid shared internal HMAC token", async () => {
    const sessionName = await createSandboxSession("commit-signing-hmac");
    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/commit-signing`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(401);
  });

  it("returns an explicit disabled response to the authenticated sandbox", async () => {
    const sessionName = await createSandboxSession("commit-signing");

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/commit-signing`, {
      headers: { Authorization: "Bearer sandbox-token" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ enabled: false });
  });

  it("rejects missing, invalid, and wrong-session sandbox tokens", async () => {
    const firstSession = await createSandboxSession("commit-signing-a", "first-token", "sandbox-a");
    const secondSession = await createSandboxSession(
      "commit-signing-b",
      "second-token",
      "sandbox-b"
    );

    const missing = await SELF.fetch(`https://test.local/sessions/${firstSession}/commit-signing`);
    const invalid = await SELF.fetch(`https://test.local/sessions/${firstSession}/commit-signing`, {
      headers: { Authorization: "Bearer invalid" },
    });
    const wrongSession = await SELF.fetch(
      `https://test.local/sessions/${secondSession}/commit-signing`,
      { headers: { Authorization: "Bearer first-token" } }
    );

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(wrongSession.status).toBe(401);
  });

  it("returns the purpose-specific decrypted configuration with no-store", async () => {
    const sessionName = await createSandboxSession("commit-signing-active");
    await saveConfiguration({
      publicKey: "ssh-ed25519 AAAA public",
      fingerprint: "SHA256:fingerprint",
      validatedAt: Date.now(),
    });

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/commit-signing`, {
      headers: { Authorization: "Bearer sandbox-token" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      enabled: true,
      keyFormat: "ssh-ed25519",
      githubLogin: "open-inspect-bot",
      committerName: "Open Inspect",
      committerEmail: "open-inspect@example.com",
      publicKey: "ssh-ed25519 AAAA public",
      fingerprint: "SHA256:fingerprint",
      privateKey: PRIVATE_KEY,
    });
  });

  it("returns a bounded error when ciphertext cannot be decrypted", async () => {
    const sessionName = await createSandboxSession("commit-signing-corrupt");
    await saveConfiguration({
      publicKey: "ssh-ed25519 AAAA public",
      fingerprint: "SHA256:fingerprint",
      validatedAt: Date.now(),
    });
    await env.DB.prepare(
      "UPDATE commit_signing_configuration SET encrypted_private_key = 'corrupt' WHERE singleton_id = 1"
    ).run();

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/commit-signing`, {
      headers: { Authorization: "Bearer sandbox-token" },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("configuration unavailable");
    expect(body).not.toContain("corrupt");
    expect(body).not.toContain("OPENSSH PRIVATE KEY");
  });
});
