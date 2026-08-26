import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { ProviderDefaultStore } from "../../src/db/provider-account-defaults";
import { SessionIndexStore } from "../../src/db/session-index";
import { initializeSession } from "../../src/session/initialize";
import { resolveSessionProviderAuth } from "../../src/session/provider-account-resolution";
import { cleanD1Tables } from "./cleanup";

const FIRST_ACCOUNT_ID = "1".repeat(32);
const SECOND_ACCOUNT_ID = "2".repeat(32);

describe("session provider auth persistence", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.exec(
      "DELETE FROM model_provider_account_defaults; DELETE FROM model_provider_account_credentials; DELETE FROM model_provider_accounts;"
    );
  });

  it("keeps the authoritative D1 snapshot when the installation default changes", async () => {
    const accounts = new ModelProviderAccountStore(env.DB);
    const defaults = new ProviderDefaultStore(env.DB);
    await accounts.create({
      id: FIRST_ACCOUNT_ID,
      provider: "openai",
      displayName: "First",
      now: 10,
    });
    await accounts.create({
      id: SECOND_ACCOUNT_ID,
      provider: "openai",
      displayName: "Second",
      now: 20,
    });
    await defaults.set("openai", FIRST_ACCOUNT_ID, "provider_account", null, 30);

    const providerAuth = await resolveSessionProviderAuth(env.DB, { unattended: false });
    const sessionId = `provider-auth-${Date.now()}`;
    await initializeSession(
      env,
      {
        sessionId,
        repoOwner: null,
        repoName: null,
        repoId: null,
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: null,
        participantUserId: "user-1",
        platformUserId: null,
        scmTokenEncrypted: null,
        scmRefreshTokenEncrypted: null,
        providerAuth,
      },
      {
        db: env.DB,
        trace_id: "provider-auth-trace",
        request_id: "provider-auth-request",
        metrics: { queries: [], totalQueryDurationMs: 0 },
      } as never
    );

    await defaults.set("openai", SECOND_ACCOUNT_ID, "provider_account", null, 60);

    await expect(new SessionIndexStore(env.DB).getCompleteProviderAuth(sessionId)).resolves.toEqual(
      [
        {
          provider: "openai",
          authMode: "provider_account",
          providerAccountId: FIRST_ACCOUNT_ID,
          selectionSource: "installation_default",
        },
        {
          provider: "xai",
          authMode: "legacy_scoped_oauth",
          selectionSource: "legacy_fallback",
        },
      ]
    );
  });
});
