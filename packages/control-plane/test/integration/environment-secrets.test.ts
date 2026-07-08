/**
 * EnvironmentSecretsStore: per-environment CRUD parity with repo secrets, and
 * the per-key import that copies ciphertext VERBATIM from a member repo (shared
 * encryption key, so no decrypt/re-encrypt round-trip — the plaintext never
 * transits the control plane).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { EnvironmentSecretsStore } from "../../src/db/environment-secrets";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import { decryptToken } from "../../src/auth/crypto";
import { cleanD1Tables } from "./cleanup";

const key = () => env.REPO_SECRETS_ENCRYPTION_KEY!;
const ENV_ID = "env_secrets_test";

describe("EnvironmentSecretsStore", () => {
  beforeEach(cleanD1Tables);

  it("sets, lists, decrypts, and deletes environment secrets", async () => {
    const store = new EnvironmentSecretsStore(env.DB, key());
    const res = await store.setSecrets(ENV_ID, { API_URL: "https://x", TOKEN: "abc" });
    expect(res.created).toBe(2);
    expect(res.keys.sort()).toEqual(["API_URL", "TOKEN"]);

    expect((await store.listSecretKeys(ENV_ID)).map((k) => k.key)).toEqual(["API_URL", "TOKEN"]);
    expect(await store.getDecryptedSecrets(ENV_ID)).toEqual({ API_URL: "https://x", TOKEN: "abc" });

    expect(await store.deleteSecret(ENV_ID, "TOKEN")).toBe(true);
    expect((await store.listSecretKeys(ENV_ID)).map((k) => k.key)).toEqual(["API_URL"]);
  });

  it("scopes secrets per environment", async () => {
    const store = new EnvironmentSecretsStore(env.DB, key());
    await store.setSecrets("env_a", { A: "1" });
    await store.setSecrets("env_b", { B: "2" });
    expect(Object.keys(await store.getDecryptedSecrets("env_a"))).toEqual(["A"]);
    expect(Object.keys(await store.getDecryptedSecrets("env_b"))).toEqual(["B"]);
  });

  it("imports selected repo secrets, ciphertext-verbatim (no re-encryption)", async () => {
    const repoStore = new RepoSecretsStore(env.DB, key());
    await repoStore.setSecrets(42, "acme", "web", { DB_URL: "postgres://secret", ONLY_ONE: "x" });

    const src = await env.DB.prepare(
      "SELECT key, encrypted_value FROM repo_secrets WHERE repo_id = 42"
    ).all<{ key: string; encrypted_value: string }>();
    const srcCipher = new Map((src.results ?? []).map((r) => [r.key, r.encrypted_value]));

    const envStore = new EnvironmentSecretsStore(env.DB, key());
    const result = await envStore.importFromRepo(ENV_ID, 42, ["DB_URL"]);
    expect(result.created).toBe(1);
    expect(result.keys).toEqual(["DB_URL"]);

    const copied = await env.DB.prepare(
      "SELECT encrypted_value FROM environment_secrets WHERE environment_id = ? AND key = 'DB_URL'"
    )
      .bind(ENV_ID)
      .first<{ encrypted_value: string }>();
    // Byte-identical to the source ciphertext.
    expect(copied?.encrypted_value).toBe(srcCipher.get("DB_URL"));
    // ...and decrypts to the original plaintext under the shared key.
    expect(await decryptToken(copied!.encrypted_value, key())).toBe("postgres://secret");
    // Unrequested key was not imported.
    expect((await envStore.listSecretKeys(ENV_ID)).map((k) => k.key)).toEqual(["DB_URL"]);
  });

  it("imports all repo keys when none are specified", async () => {
    const repoStore = new RepoSecretsStore(env.DB, key());
    await repoStore.setSecrets(7, "acme", "api", { A: "1", B: "2" });
    const envStore = new EnvironmentSecretsStore(env.DB, key());
    const result = await envStore.importFromRepo(ENV_ID, 7);
    expect(result.keys.sort()).toEqual(["A", "B"]);
  });

  it("no-ops when the source repo has no matching keys", async () => {
    const envStore = new EnvironmentSecretsStore(env.DB, key());
    const result = await envStore.importFromRepo(ENV_ID, 999, ["NOPE"]);
    expect(result).toEqual({ created: 0, updated: 0, keys: [] });
  });
});
