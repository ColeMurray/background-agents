import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";
import { GlobalSecretsStore } from "../../src/db/global-secrets";
import { RepoSecretsStore } from "../../src/db/repo-secrets";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, initSession } from "./helpers";
import type { SessionProviderAuthMode } from "@open-inspect/shared/types/provider-accounts";

const KEY = () => env.REPO_SECRETS_ENCRYPTION_KEY as string;

/** Invoke the DO's real (private) getUserEnvVars, exercising the session-target fold. */
function getUserEnvVars(stub: DurableObjectStub): Promise<Record<string, string> | undefined> {
  return runInDurableObject(stub, (instance: SessionDO) =>
    (
      instance as unknown as {
        getUserEnvVars(): Promise<Record<string, string> | undefined>;
      }
    ).getUserEnvVars()
  );
}

async function initSessionWithProviderAuth(
  overrides: Parameters<typeof initNamedSession>[1] = {},
  modes: Record<"openai" | "xai", SessionProviderAuthMode> = {
    openai: "legacy_scoped_oauth",
    xai: "legacy_scoped_oauth",
  }
) {
  const sessionName = `provider-auth-env-${Date.now()}-${crypto.randomUUID()}`;
  const accountIds = { openai: "1".repeat(32), xai: "2".repeat(32) } as const;
  const accounts = new ModelProviderAccountStore(env.DB);
  for (const provider of ["openai", "xai"] as const) {
    if (modes[provider] === "provider_account") {
      await accounts.create({
        id: accountIds[provider],
        provider,
        displayName: `${provider} account`,
      });
    }
  }
  const providerAuth = (["openai", "xai"] as const).map((provider) =>
    modes[provider] === "provider_account"
      ? {
          provider,
          authMode: "provider_account" as const,
          providerAccountId: accountIds[provider],
          selectionSource: "explicit",
        }
      : { provider, authMode: modes[provider], selectionSource: "explicit" }
  );
  return initNamedSession(sessionName, { ...overrides, providerAuth });
}

describe("getUserEnvVars session-target fold", () => {
  beforeEach(cleanD1Tables);

  it("folds member repo secrets with the primary winning collisions (ad-hoc list)", async () => {
    await new GlobalSecretsStore(env.DB, KEY()).setSecrets({ SHARED: "global", ONLY_GLOBAL: "g" });
    await new RepoSecretsStore(env.DB, KEY()).setSecrets(90101, "acme", "web", {
      SHARED: "web",
      ONLY_WEB: "w",
    });
    await new RepoSecretsStore(env.DB, KEY()).setSecrets(90102, "acme", "backend", {
      SHARED: "backend",
      ONLY_BACKEND: "b",
    });

    const { stub } = await initSessionWithProviderAuth({
      repoOwner: "acme",
      repoName: "web",
      repoId: 90101,
      repositories: [
        { repoOwner: "acme", repoName: "web", repoId: 90101, baseBranch: "main" },
        { repoOwner: "acme", repoName: "backend", repoId: 90102, baseBranch: "main" },
      ],
    });

    const envVars = await getUserEnvVars(stub);

    // Primary (position 0 = acme/web) merges last and wins SHARED; every layer contributes.
    expect(envVars).toMatchObject({
      SHARED: "web",
      ONLY_GLOBAL: "g",
      ONLY_WEB: "w",
      ONLY_BACKEND: "b",
    });
  });

  it("merges global with the sole repo for a scalar session (single-repo parity)", async () => {
    await new GlobalSecretsStore(env.DB, KEY()).setSecrets({ SHARED: "global", ONLY_GLOBAL: "g" });
    await new RepoSecretsStore(env.DB, KEY()).setSecrets(90201, "acme", "solo", {
      SHARED: "repo",
      ONLY_REPO: "r",
    });

    const { stub } = await initSessionWithProviderAuth({
      repoOwner: "acme",
      repoName: "solo",
      repoId: 90201,
    });

    const envVars = await getUserEnvVars(stub);

    expect(envVars).toMatchObject({ SHARED: "repo", ONLY_GLOBAL: "g", ONLY_REPO: "r" });
  });

  it("advertises provider accounts even when there are no ordinary secrets", async () => {
    const { stub } = await initSessionWithProviderAuth(undefined, {
      openai: "provider_account",
      xai: "provider_account",
    });

    await expect(getUserEnvVars(stub)).resolves.toEqual({
      OPENAI_OAUTH_MANAGED: "1",
      XAI_OAUTH_MANAGED: "1",
    });
  });

  it.each([
    {
      modes: { openai: "provider_account", xai: "api_key" } as const,
      expected: { OPENAI_OAUTH_MANAGED: "1", XAI_API_KEY: "xai-key" },
    },
    {
      modes: { openai: "api_key", xai: "provider_account" } as const,
      expected: { OPENAI_API_KEY: "openai-key", XAI_OAUTH_MANAGED: "1" },
    },
  ])("uses authoritative D1 provider auth modes for $modes", async ({ modes, expected }) => {
    await new GlobalSecretsStore(env.DB, KEY()).setSecrets({
      OPENAI_API_KEY: "openai-key",
      XAI_API_KEY: "xai-key",
      OPENAI_OAUTH_REFRESH_TOKEN: "legacy-openai",
      XAI_OAUTH_REFRESH_TOKEN: "legacy-xai",
    });
    const { stub } = await initSessionWithProviderAuth(undefined, modes);

    await expect(getUserEnvVars(stub)).resolves.toEqual(expected);
  });

  it("preserves scoped OAuth for legacy-bound sessions", async () => {
    await new GlobalSecretsStore(env.DB, KEY()).setSecrets({
      OPENAI_API_KEY: "openai-key",
      XAI_API_KEY: "xai-key",
      OPENAI_OAUTH_REFRESH_TOKEN: "legacy-openai",
    });
    const { stub } = await initSessionWithProviderAuth();

    await expect(getUserEnvVars(stub)).resolves.toEqual({
      OPENAI_OAUTH_MANAGED: "1",
      XAI_API_KEY: "xai-key",
    });
  });

  it("fails closed when the D1 provider auth snapshot is incomplete", async () => {
    const { stub, sessionName } = await initSession();
    await env.DB.prepare(
      "DELETE FROM session_model_provider_auth WHERE session_id = ? AND provider = 'xai'"
    )
      .bind(sessionName)
      .run();

    await expect(getUserEnvVars(stub)).rejects.toThrow(/provider auth snapshot is incomplete/);
  });
});
