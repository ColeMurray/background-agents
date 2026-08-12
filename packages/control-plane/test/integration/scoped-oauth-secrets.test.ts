import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { ScopedOAuthSecretsStore, type OAuthSecretScope } from "../../src/db/scoped-oauth-secrets";
import type { StoredSecretValue } from "../../src/db/scoped-secrets";
import { cleanD1Tables } from "./cleanup";

// base64 of exactly 32 bytes — encryptToken imports the decoded bytes as a raw AES-256 key.
const ENCRYPTION_KEY = "aW50ZWdyYXRpb24tdGVzdC1rZXktMzItYnl0ZXMhISE=";
const REFRESH_KEY = "OPENAI_OAUTH_REFRESH_TOKEN";

function store(): ScopedOAuthSecretsStore {
  return new ScopedOAuthSecretsStore(env.DB, ENCRYPTION_KEY);
}

async function readGuard(scope: OAuthSecretScope): Promise<StoredSecretValue> {
  const stored = await store().readSecretWithCiphertext(scope, REFRESH_KEY);
  if (!stored) throw new Error("expected a stored refresh token");
  return stored;
}

const SCOPES: Array<{ name: string; scope: OAuthSecretScope }> = [
  { name: "global", scope: { kind: "global" } },
  { name: "repo", scope: { kind: "repo", repoId: 4242, repoOwner: "acme", repoName: "web" } },
  { name: "environment", scope: { kind: "environment", environmentId: "env-itest" } },
];

describe("ScopedOAuthSecretsStore", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    // environment_secrets has an FK to environments; the repo scope needs no parent row.
    await env.DB.prepare(
      "INSERT INTO environments (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
      .bind("env-itest", "scoped-oauth-itest", Date.now(), Date.now())
      .run();
  });

  describe.each(SCOPES)("$name scope", ({ scope }) => {
    it("reads a secret together with its stored ciphertext", async () => {
      await store().write(scope, { [REFRESH_KEY]: "rt-old" });

      const stored = await readGuard(scope);

      expect(stored.value).toBe("rt-old");
      expect(stored.ciphertext).toBeTruthy();
      expect(stored.ciphertext).not.toContain("rt-old");
    });

    it("swaps the guard row and writes companions when the ciphertext matches", async () => {
      await store().write(scope, { [REFRESH_KEY]: "rt-old" });
      const stored = await readGuard(scope);

      const swapped = await store().casWrite(
        scope,
        { key: REFRESH_KEY, expectedCiphertext: stored.ciphertext },
        { [REFRESH_KEY]: "rt-new", OPENAI_OAUTH_ACCESS_TOKEN: "at-new" }
      );

      expect(swapped).toBe(true);
      await expect(store().read(scope)).resolves.toMatchObject({
        [REFRESH_KEY]: "rt-new",
        OPENAI_OAUTH_ACCESS_TOKEN: "at-new",
      });
    });

    it("refuses a stale guard and leaves the winner's write intact", async () => {
      await store().write(scope, { [REFRESH_KEY]: "rt-old" });
      const stale = await readGuard(scope);

      const winner = await store().casWrite(
        scope,
        { key: REFRESH_KEY, expectedCiphertext: stale.ciphertext },
        { [REFRESH_KEY]: "rt-winner", OPENAI_OAUTH_ACCESS_TOKEN: "at-winner" }
      );
      expect(winner).toBe(true);

      const loser = await store().casWrite(
        scope,
        { key: REFRESH_KEY, expectedCiphertext: stale.ciphertext },
        { [REFRESH_KEY]: "rt-loser", OPENAI_OAUTH_ACCESS_TOKEN: "at-loser" }
      );

      expect(loser).toBe(false);
      await expect(store().read(scope)).resolves.toMatchObject({
        [REFRESH_KEY]: "rt-winner",
        OPENAI_OAUTH_ACCESS_TOKEN: "at-winner",
      });
    });
  });

  it("returns the exact stored ciphertext bytes", async () => {
    const scope: OAuthSecretScope = { kind: "global" };
    await store().write(scope, { [REFRESH_KEY]: "rt-bytes" });

    const stored = await readGuard(scope);
    const row = await env.DB.prepare("SELECT encrypted_value FROM global_secrets WHERE key = ?")
      .bind(REFRESH_KEY)
      .first<{ encrypted_value: string }>();

    expect(stored.ciphertext).toBe(row?.encrypted_value);
  });

  it("returns null for a missing secret", async () => {
    await expect(
      store().readSecretWithCiphertext({ kind: "global" }, REFRESH_KEY)
    ).resolves.toBeNull();
  });

  it("rejects a casWrite whose secrets omit the guard key", async () => {
    await expect(
      store().casWrite(
        { kind: "global" },
        { key: REFRESH_KEY, expectedCiphertext: "irrelevant" },
        { OPENAI_OAUTH_ACCESS_TOKEN: "at-only" }
      )
    ).rejects.toThrow("guard key");
  });
});
