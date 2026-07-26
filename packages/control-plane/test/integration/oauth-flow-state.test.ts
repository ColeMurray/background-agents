import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../../src/auth/crypto";
import {
  OAuthFlowVerifierIntegrityError,
  type OAuthFlowVerifierCipher,
} from "../../src/auth/oauth-flow-verifier";
import { ProviderPkceFlowCipher } from "../../src/auth/auth-encryption";
import {
  InvalidOAuthFlowStateInputError,
  OAuthFlowStateStore,
} from "../../src/db/oauth-flow-state";
import type {
  CreateOAuthFlowStateInput,
  OAuthFlowStateConsumptionError,
} from "../../src/db/oauth-flow-state";
import { cleanD1Tables } from "./cleanup";

const NOW_MS = 1_800_000_000_000;
const ROOT_KEY_BASE64 = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex"
).toString("base64");
const STATE = "s".repeat(43);
const CLIENT_CHALLENGE = "c".repeat(43);
const PROVIDER_VERIFIER = "v".repeat(43);
const OIDC_NONCE = "n".repeat(43);

describe("OAuthFlowStateStore", () => {
  beforeEach(cleanD1Tables);

  function createStore(
    now = NOW_MS,
    verifierCipher: OAuthFlowVerifierCipher = new ProviderPkceFlowCipher(ROOT_KEY_BASE64)
  ): OAuthFlowStateStore {
    return new OAuthFlowStateStore(env.DB, verifierCipher, {
      clock: { now: () => now },
      idGenerator: { generate: () => "flow-1" },
      tokenHasher: { hash: hashToken },
    });
  }

  it("stores only protected transaction values and consumes the bound flow once", async () => {
    const store = createStore();
    await store.create({
      state: STATE,
      provider: "google",
      clientId: "web",
      redirectUri: "https://web.example/api/auth/callback",
      clientCodeChallenge: CLIENT_CHALLENGE,
      providerPkceVerifier: PROVIDER_VERIFIER,
      oidcNonce: OIDC_NONCE,
    });

    const row = await env.DB.prepare("SELECT * FROM oauth_flow_state").first();
    expect(row).toMatchObject({
      id: "flow-1",
      state_hash: await hashToken(STATE),
      provider: "google",
      provider_pkce_key_version: 1,
      oidc_nonce_hash: await hashToken(OIDC_NONCE),
      consumed_at: null,
    });
    expect(JSON.stringify(row)).not.toContain(STATE);
    expect(JSON.stringify(row)).not.toContain(PROVIDER_VERIFIER);
    expect(JSON.stringify(row)).not.toContain(OIDC_NONCE);

    await expect(store.consume(STATE, "google")).resolves.toMatchObject({
      flowId: "flow-1",
      provider: "google",
      clientCodeChallenge: CLIENT_CHALLENGE,
      providerPkceVerifier: PROVIDER_VERIFIER,
      oidcNonceHash: await hashToken(OIDC_NONCE),
    });
    await expect(store.consume(STATE, "google")).rejects.toEqual(
      expect.objectContaining<OAuthFlowStateConsumptionError>({
        name: "OAuthFlowStateConsumptionError",
        rejection: "already_consumed",
      })
    );
  });

  it("does not consume a flow on provider mix-up", async () => {
    const store = createStore();
    await store.create({
      state: STATE,
      provider: "github",
      clientId: "web",
      redirectUri: "https://web.example/api/auth/callback",
      clientCodeChallenge: CLIENT_CHALLENGE,
      providerPkceVerifier: PROVIDER_VERIFIER,
    });

    await expect(store.consume(STATE, "google")).rejects.toEqual(
      expect.objectContaining<OAuthFlowStateConsumptionError>({
        rejection: "provider_mismatch",
      })
    );
    await expect(store.consume(STATE, "github")).resolves.toMatchObject({
      provider: "github",
    });
  });

  it("allows exactly one concurrent consumer", async () => {
    const store = createStore();
    await store.create({
      state: STATE,
      provider: "github",
      clientId: "web",
      redirectUri: "https://web.example/api/auth/callback",
      clientCodeChallenge: CLIENT_CHALLENGE,
      providerPkceVerifier: PROVIDER_VERIFIER,
    });

    const results = await Promise.allSettled([
      store.consume(STATE, "github"),
      store.consume(STATE, "github"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects a flow at the exact expiry boundary without consuming it", async () => {
    await createStore().create({
      state: STATE,
      provider: "github",
      clientId: "web",
      redirectUri: "https://web.example/api/auth/callback",
      clientCodeChallenge: CLIENT_CHALLENGE,
      providerPkceVerifier: PROVIDER_VERIFIER,
    });

    const expiredStore = createStore(NOW_MS + 10 * 60 * 1000);
    await expect(expiredStore.consume(STATE, "github")).rejects.toEqual(
      expect.objectContaining<OAuthFlowStateConsumptionError>({
        rejection: "expired",
      })
    );
    await expect(
      env.DB.prepare("SELECT consumed_at FROM oauth_flow_state WHERE id = 'flow-1'").first()
    ).resolves.toEqual({ consumed_at: null });
  });

  it("fails closed on ciphertext corruption without consuming the flow", async () => {
    const store = createStore();
    await store.create({
      state: STATE,
      provider: "google",
      clientId: "web",
      redirectUri: "https://web.example/api/auth/callback",
      clientCodeChallenge: CLIENT_CHALLENGE,
      providerPkceVerifier: PROVIDER_VERIFIER,
      oidcNonce: OIDC_NONCE,
    });
    await env.DB.prepare(
      "UPDATE oauth_flow_state SET provider_pkce_verifier_ciphertext = ? WHERE id = ?"
    )
      .bind(btoa("corrupt-ciphertext-that-is-long-enough"), "flow-1")
      .run();

    await expect(store.consume(STATE, "google")).rejects.toEqual(
      expect.objectContaining<OAuthFlowStateConsumptionError>({
        rejection: "corrupt",
      })
    );
    await expect(
      env.DB.prepare("SELECT consumed_at FROM oauth_flow_state WHERE id = 'flow-1'").first()
    ).resolves.toEqual({ consumed_at: null });
  });

  it("normalizes integrity failures declared by the cipher port", async () => {
    await createStore().create({
      state: STATE,
      provider: "github",
      clientId: "web",
      redirectUri: "https://web.example/api/auth/callback",
      clientCodeChallenge: CLIENT_CHALLENGE,
      providerPkceVerifier: PROVIDER_VERIFIER,
    });
    const failingCipher: OAuthFlowVerifierCipher = {
      encrypt: async () => {
        throw new Error("unexpected encryption");
      },
      decrypt: async () => {
        throw new OAuthFlowVerifierIntegrityError();
      },
    };

    await expect(createStore(NOW_MS, failingCipher).consume(STATE, "github")).rejects.toEqual(
      expect.objectContaining<OAuthFlowStateConsumptionError>({
        rejection: "corrupt",
      })
    );
  });

  it("rejects provider-inconsistent nonce input before writing state", async () => {
    const store = createStore();
    await expect(
      store.create({
        state: STATE,
        provider: "google",
        clientId: "web",
        redirectUri: "https://web.example/api/auth/callback",
        clientCodeChallenge: CLIENT_CHALLENGE,
        providerPkceVerifier: PROVIDER_VERIFIER,
      } as unknown as CreateOAuthFlowStateInput)
    ).rejects.toBeInstanceOf(InvalidOAuthFlowStateInputError);
    await expect(
      store.create({
        state: STATE,
        provider: "github",
        clientId: "web",
        redirectUri: "https://web.example/api/auth/callback",
        clientCodeChallenge: CLIENT_CHALLENGE,
        providerPkceVerifier: PROVIDER_VERIFIER,
        oidcNonce: OIDC_NONCE,
      } as unknown as CreateOAuthFlowStateInput)
    ).rejects.toBeInstanceOf(InvalidOAuthFlowStateInputError);
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM oauth_flow_state").first()
    ).resolves.toEqual({ count: 0 });
  });
});
