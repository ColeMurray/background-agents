import { beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";

import { generateInternalToken } from "@open-inspect/shared";
import { signGitPayloadWithOpenSshEd25519PrivateKey } from "../../src/auth/openssh-ed25519";
import { CommitSigningStore } from "../../src/db/commit-signing";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth, serviceFetch } from "./helpers";

const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6QAAAKAVa6SnFWuk
pwAAAAtzc2gtZWQyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6Q
AAAEDu3j73XlXgmmJ6DeqA0/0I1EGPhOmMnk/be7rZrpUxDBaM0ggz8RWOz0lq3xs+vNPv
nuWs0SS30txpSJTb357pAAAAGXRlc3Qtc2lnbmluZ0BvcGVuLWluc3BlY3QBAgME
-----END OPENSSH PRIVATE KEY-----`;
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBaM0ggz8RWOz0lq3xs+vNPvnuWs0SS30txpSJTb357p";
const FINGERPRINT = "SHA256:Cu64KulDfH7B8Mu37+JWepAJ1m59o159Y8RPj5Ta1XM";
type StoredConfiguration = Parameters<CommitSigningStore["save"]>[0];

const STORED_CONFIGURATION: StoredConfiguration = {
  privateKey: PRIVATE_KEY,
  committerName: "Open Inspect",
  committerEmail: "open-inspect@example.com",
  publicKey: "ssh-ed25519 AAAA test",
  fingerprint: "SHA256:test",
};

const WRITE_REQUEST = {
  privateKey: PRIVATE_KEY,
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
    expect(await store.getMetadata()).toEqual({
      committerName: "Open Inspect",
      committerEmail: "open-inspect@example.com",
      publicKey: "ssh-ed25519 AAAA test",
      fingerprint: "SHA256:test",
      updatedAt: expect.any(String),
    });
  });

  it("returns public-only runtime configuration to the sandbox boundary", async () => {
    const store = await saveConfiguration();

    const configuration = await store.getRuntimeConfiguration();

    expect(configuration).toEqual({
      committerName: "Open Inspect",
      committerEmail: "open-inspect@example.com",
      publicKey: "ssh-ed25519 AAAA test",
    });
    expect(JSON.stringify(configuration)).not.toContain("privateKey");
    expect(JSON.stringify(configuration)).not.toContain("OPENSSH PRIVATE KEY");
  });

  it("returns null runtime configuration when signing is not configured", async () => {
    expect(await createStore().getRuntimeConfiguration()).toBeNull();
  });

  it("returns null decrypted configuration when signing is not configured", async () => {
    expect(await createStore().getDecryptedSigningConfiguration()).toBeNull();
  });

  it("leaves an active row unchanged when encryption fails", async () => {
    await saveConfiguration();
    const before = await env.DB.prepare(
      "SELECT * FROM commit_signing_configuration WHERE singleton_id = 1"
    ).first();

    await expect(
      new CommitSigningStore(env.DB, "not-base64").save({
        ...STORED_CONFIGURATION,
        committerName: "Replacement",
      })
    ).rejects.toThrow();

    expect(
      await env.DB.prepare(
        "SELECT * FROM commit_signing_configuration WHERE singleton_id = 1"
      ).first()
    ).toEqual(before);
  });

  it("deletes the active configuration idempotently", async () => {
    const store = await saveConfiguration();

    await expect(store.delete()).resolves.toBeUndefined();
    await expect(store.delete()).resolves.toBeUndefined();
    expect(await store.getMetadata()).toBeNull();
  });
});

describe("commit signing settings API", () => {
  beforeEach(cleanD1Tables);

  it("returns disabled metadata with no-store when no key is configured", async () => {
    const response = await serviceFetch("https://test.local/commit-signing");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ enabled: false });
  });

  it("validates and stores a key while returning public metadata only", async () => {
    const response = await serviceFetch("https://test.local/commit-signing", {
      method: "PUT",
      body: JSON.stringify(WRITE_REQUEST),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual({
      enabled: true,
      committerName: "Open Inspect",
      committerEmail: "open-inspect@example.com",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBaM0ggz8RWOz0lq3xs+vNPvnuWs0SS30txpSJTb357p",
      fingerprint: "SHA256:Cu64KulDfH7B8Mu37+JWepAJ1m59o159Y8RPj5Ta1XM",
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("OPENSSH PRIVATE KEY");
  });

  it("deletes the active ciphertext when signing is disabled", async () => {
    await saveConfiguration();
    const response = await serviceFetch("https://test.local/commit-signing", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ enabled: false });
    expect(await env.DB.prepare("SELECT 1 FROM commit_signing_configuration").first()).toBeNull();
  });

  it("atomically replaces configuration and advances the update timestamp", async () => {
    await saveConfiguration({
      committerName: "Old Name",
      committerEmail: "old@example.com",
      publicKey: "ssh-ed25519 AAAA old",
      fingerprint: "SHA256:old",
    });
    await env.DB.prepare(
      "UPDATE commit_signing_configuration SET updated_at = 1 WHERE singleton_id = 1"
    ).run();
    const response = await serviceFetch("https://test.local/commit-signing", {
      method: "PUT",
      body: JSON.stringify({
        privateKey: PRIVATE_KEY,
        committerName: "New Name",
        committerEmail: "new@example.com",
      }),
    });

    expect(response.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT committer_name, committer_email, updated_at FROM commit_signing_configuration WHERE singleton_id = 1"
    ).first<{
      committer_name: string;
      committer_email: string;
      updated_at: number;
    }>();
    expect(row?.committer_name).toBe("New Name");
    expect(row?.committer_email).toBe("new@example.com");
    expect(row?.updated_at).toBeGreaterThan(1);
  });

  it("leaves the active row unchanged after validation failure and redacts the response", async () => {
    await saveConfiguration({
      committerName: "Old Name",
      committerEmail: "old@example.com",
      publicKey: "ssh-ed25519 AAAA old",
      fingerprint: "SHA256:old",
    });
    const before = await env.DB.prepare(
      "SELECT * FROM commit_signing_configuration WHERE singleton_id = 1"
    ).first();
    const submittedKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-bytes\n";

    const response = await serviceFetch("https://test.local/commit-signing", {
      method: "PUT",
      body: JSON.stringify({
        privateKey: submittedKey,
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

  it.each(["GET", "POST"])("rejects a valid shared internal HMAC token for %s", async (method) => {
    const sessionName = await createSandboxSession("commit-signing-hmac");
    const token = await generateInternalToken("test-hmac-secret-for-integration-tests");

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/commit-signing`, {
      method,
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

  it("returns public-only runtime configuration with no-store", async () => {
    const sessionName = await createSandboxSession("commit-signing-active");
    await saveConfiguration({
      publicKey: "ssh-ed25519 AAAA public",
      fingerprint: "SHA256:fingerprint",
    });

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/commit-signing`, {
      headers: { Authorization: "Bearer sandbox-token" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      enabled: true,
      committerName: "Open Inspect",
      committerEmail: "open-inspect@example.com",
      publicKey: "ssh-ed25519 AAAA public",
    });
  });

  it("does not decrypt ciphertext when returning runtime configuration", async () => {
    const sessionName = await createSandboxSession("commit-signing-corrupt");
    await saveConfiguration({
      publicKey: "ssh-ed25519 AAAA public",
      fingerprint: "SHA256:fingerprint",
    });
    await env.DB.prepare(
      "UPDATE commit_signing_configuration SET encrypted_private_key = 'corrupt' WHERE singleton_id = 1"
    ).run();

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/commit-signing`, {
      headers: { Authorization: "Bearer sandbox-token" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(
      expect.objectContaining({ enabled: true, publicKey: "ssh-ed25519 AAAA public" })
    );
    expect(body).not.toContain("corrupt");
    expect(body).not.toContain("OPENSSH PRIVATE KEY");
  });

  it("returns an armored signature for the exact authenticated payload bytes", async () => {
    const sessionName = await createSandboxSession("commit-signing-sign");
    await saveConfiguration({
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
    });
    const payload = new Uint8Array([0, 1, 2, 255, 10]);

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/commit-signing`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sandbox-token",
        "Content-Type": "application/octet-stream",
        "X-Open-Inspect-Signing-Fingerprint": FINGERPRINT,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(
      (await signGitPayloadWithOpenSshEd25519PrivateKey(PRIVATE_KEY, payload)).armoredSignature
    );
  });

  it("rejects a streamed payload larger than one MiB", async () => {
    const sessionName = await createSandboxSession("commit-signing-oversized");
    await saveConfiguration({
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(768 * 1024));
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
        controller.close();
      },
    });

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/commit-signing`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sandbox-token",
        "Content-Type": "application/octet-stream",
        "X-Open-Inspect-Signing-Fingerprint": FINGERPRINT,
      },
      body,
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects missing fingerprint and empty signing payloads", async () => {
    const sessionName = await createSandboxSession("commit-signing-invalid");

    const missingFingerprint = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/commit-signing`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer sandbox-token",
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array([1]),
      }
    );
    const emptyPayload = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/commit-signing`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer sandbox-token",
          "Content-Type": "application/octet-stream",
          "X-Open-Inspect-Signing-Fingerprint": FINGERPRINT,
        },
        body: new Uint8Array(),
      }
    );

    expect(missingFingerprint.status).toBe(400);
    expect(emptyPayload.status).toBe(400);
  });

  it("binds signing to the active fingerprint and rejects requests after disable", async () => {
    const sessionName = await createSandboxSession("commit-signing-rotation");
    const store = await saveConfiguration({
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
    });

    await store.save({
      ...STORED_CONFIGURATION,
      publicKey: "ssh-ed25519 AAAA replacement",
      fingerprint: "SHA256:replacement",
    });
    const afterReplacement = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/commit-signing`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer sandbox-token",
          "Content-Type": "application/octet-stream",
          "X-Open-Inspect-Signing-Fingerprint": FINGERPRINT,
        },
        body: new Uint8Array([1]),
      }
    );
    await store.delete();
    const afterDisable = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/commit-signing`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer sandbox-token",
          "Content-Type": "application/octet-stream",
          "X-Open-Inspect-Signing-Fingerprint": "SHA256:replacement",
        },
        body: new Uint8Array([1]),
      }
    );

    expect(afterReplacement.status).toBe(409);
    expect(afterDisable.status).toBe(409);
  });

  it("returns a redacted failure when signing ciphertext cannot be decrypted", async () => {
    const sessionName = await createSandboxSession("commit-signing-corrupt-sign");
    await saveConfiguration({
      publicKey: PUBLIC_KEY,
      fingerprint: FINGERPRINT,
    });
    await env.DB.prepare(
      "UPDATE commit_signing_configuration SET encrypted_private_key = 'corrupt' WHERE singleton_id = 1"
    ).run();

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/commit-signing`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sandbox-token",
        "Content-Type": "application/octet-stream",
        "X-Open-Inspect-Signing-Fingerprint": FINGERPRINT,
      },
      body: new Uint8Array([1]),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toContain("corrupt");
    expect(body).not.toContain("OPENSSH PRIVATE KEY");
  });

  it("rejects a dead sandbox token before signing", async () => {
    const sessionName = `${"commit-signing-dead"}-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuth(stub, {
      authToken: "dead-token",
      sandboxId: "dead-sandbox",
      status: "stopped",
    });

    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/commit-signing`, {
      method: "POST",
      headers: {
        Authorization: "Bearer dead-token",
        "Content-Type": "application/octet-stream",
        "X-Open-Inspect-Signing-Fingerprint": FINGERPRINT,
      },
      body: new Uint8Array([1]),
    });

    expect(response.status).toBe(401);
  });
});
