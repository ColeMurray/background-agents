import { describe, expect, it, vi } from "vitest";
import { OpenAIModelProviderAccountAdapter } from "../auth/model-provider-account-openai-adapter";
import { AnthropicModelProviderAccountAdapter } from "../auth/model-provider-account-anthropic-adapter";
import type { ProcessingProviderAuthorization } from "../db/provider-account-authorizations";
import type { ModelProviderAccountLifecycleSnapshot } from "../db/model-provider-accounts";
import { ProviderDeviceAuthorizationFinalizer } from "./device-authorization-finalizer";

const authorization: ProcessingProviderAuthorization = {
  id: "01".repeat(32),
  userId: "user-1",
  provider: "openai",
  authorizationKind: "device",
  operation: "create",
  displayName: "Primary OpenAI",
  encryptedProviderData: "encrypted",
  providerStateVersion: 1,
  intervalMs: 5_000,
  nextPollAt: 100_000,
  expiresAt: 700_000,
  state: "processing",
  processingOwner: "owner-1",
  processingStartedAt: 100_000,
  createdAt: 1,
  updatedAt: 100_000,
};

const winner: ModelProviderAccountLifecycleSnapshot = {
  account: {
    id: "02".repeat(16),
    provider: "openai",
    displayName: "Existing OpenAI",
    externalAccountId: "acct-1",
    status: "active",
    createdBy: "user-2",
    updatedBy: "user-2",
    lastVerifiedAt: 1,
    lastUsedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  },
  lifecycleVersion: 0,
};

const connection = {
  credential: { refreshToken: "new-secret" },
  externalAccountId: "acct-1",
};

function subject(createOutcome: "created" | "identity_conflict" | "claim_lost") {
  const accounts = {
    getLifecycleSnapshot: vi.fn(async () => winner),
    findLifecycleSnapshotByExternalIdentity: vi
      .fn<() => Promise<ModelProviderAccountLifecycleSnapshot | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winner),
  };
  const writer = {
    finalizeDeviceAuthorizationCreate: vi.fn(async () => ({ type: createOutcome })),
    finalizeDeviceAuthorizationReconnect: vi.fn(async () => ({ type: "connected" as const })),
  };
  return {
    accounts,
    writer,
    finalizer: new ProviderDeviceAuthorizationFinalizer(accounts, writer, () => "03".repeat(16)),
  };
}

describe("ProviderDeviceAuthorizationFinalizer", () => {
  it("converges only an explicit external identity conflict onto its winner", async () => {
    const { finalizer, accounts, writer } = subject("identity_conflict");

    await expect(
      finalizer.finalizeTrustedConnection(
        authorization,
        connection,
        new OpenAIModelProviderAccountAdapter(),
        100_000
      )
    ).resolves.toBe(true);
    expect(accounts.findLifecycleSnapshotByExternalIdentity).toHaveBeenCalledTimes(2);
    expect(writer.finalizeDeviceAuthorizationReconnect).toHaveBeenCalledOnce();
  });

  it("returns false without convergence when the processing claim is lost", async () => {
    const { finalizer, accounts, writer } = subject("claim_lost");

    await expect(
      finalizer.finalizeTrustedConnection(
        authorization,
        connection,
        new OpenAIModelProviderAccountAdapter(),
        100_000
      )
    ).resolves.toBe(false);
    expect(accounts.findLifecycleSnapshotByExternalIdentity).toHaveBeenCalledOnce();
    expect(writer.finalizeDeviceAuthorizationReconnect).not.toHaveBeenCalled();
  });

  it("propagates create failures instead of treating them as identity conflicts", async () => {
    const { finalizer, accounts, writer } = subject("created");
    writer.finalizeDeviceAuthorizationCreate.mockRejectedValueOnce(new Error("encryption failed"));

    await expect(
      finalizer.finalizeTrustedConnection(
        authorization,
        connection,
        new OpenAIModelProviderAccountAdapter(),
        100_000
      )
    ).rejects.toThrow("encryption failed");
    expect(accounts.findLifecycleSnapshotByExternalIdentity).toHaveBeenCalledOnce();
    expect(writer.finalizeDeviceAuthorizationReconnect).not.toHaveBeenCalled();
  });

  describe("identity-less connections", () => {
    const anthropicCreate: ProcessingProviderAuthorization = {
      ...authorization,
      provider: "anthropic",
      authorizationKind: "authorization_code",
    };
    const identityless = {
      credential: { kind: "setup_token", token: "sk-ant-oat01-secret" },
    };

    it("creates a fresh named slot on every create without identity lookups", async () => {
      const { finalizer, accounts, writer } = subject("created");

      await expect(
        finalizer.finalizeTrustedConnection(
          anthropicCreate,
          identityless,
          new AnthropicModelProviderAccountAdapter(),
          100_000
        )
      ).resolves.toBe(true);
      expect(accounts.findLifecycleSnapshotByExternalIdentity).not.toHaveBeenCalled();
      expect(writer.finalizeDeviceAuthorizationCreate).toHaveBeenCalledWith(
        expect.objectContaining({ externalAccountId: null, accountId: "03".repeat(16) })
      );
      expect(writer.finalizeDeviceAuthorizationReconnect).not.toHaveBeenCalled();
    });

    it("writes a reconnect straight to the identity-less target account", async () => {
      const { finalizer, accounts, writer } = subject("created");
      accounts.getLifecycleSnapshot.mockResolvedValue({
        account: { ...winner.account, provider: "anthropic", externalAccountId: null },
        lifecycleVersion: 4,
      });

      await expect(
        finalizer.finalizeTrustedConnection(
          {
            ...anthropicCreate,
            operation: "reconnect",
            providerAccountId: winner.account.id,
            targetAccountStatus: "reconnect_required",
            targetAccountLifecycleVersion: 4,
          } as ProcessingProviderAuthorization,
          identityless,
          new AnthropicModelProviderAccountAdapter(),
          100_000
        )
      ).resolves.toBe(true);
      expect(writer.finalizeDeviceAuthorizationReconnect).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: winner.account.id, externalAccountId: null })
      );
    });

    it("keeps an identity-less target identity-less when the reconnect names an account", async () => {
      const { finalizer, accounts, writer } = subject("created");
      accounts.getLifecycleSnapshot.mockResolvedValue({
        account: { ...winner.account, provider: "anthropic", externalAccountId: null },
        lifecycleVersion: 4,
      });

      await expect(
        finalizer.finalizeTrustedConnection(
          {
            ...anthropicCreate,
            operation: "reconnect",
            providerAccountId: winner.account.id,
            targetAccountStatus: "reconnect_required",
            targetAccountLifecycleVersion: 4,
          } as ProcessingProviderAuthorization,
          { ...identityless, externalAccountId: "claude-account-uuid" },
          new AnthropicModelProviderAccountAdapter(),
          100_000
        )
      ).resolves.toBe(true);
      expect(writer.finalizeDeviceAuthorizationReconnect).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: winner.account.id, externalAccountId: null })
      );
    });

    it("refuses a named reconnect onto a slot bound to another identity", async () => {
      const { finalizer, accounts, writer } = subject("created");
      accounts.getLifecycleSnapshot.mockResolvedValue({
        account: { ...winner.account, provider: "anthropic", externalAccountId: "other-account" },
        lifecycleVersion: 4,
      });

      await expect(
        finalizer.finalizeTrustedConnection(
          {
            ...anthropicCreate,
            operation: "reconnect",
            providerAccountId: winner.account.id,
            targetAccountStatus: "active",
            targetAccountLifecycleVersion: 4,
          } as ProcessingProviderAuthorization,
          { ...identityless, externalAccountId: "claude-account-uuid" },
          new AnthropicModelProviderAccountAdapter(),
          100_000
        )
      ).rejects.toThrow(/did not match/);
      expect(writer.finalizeDeviceAuthorizationReconnect).not.toHaveBeenCalled();
    });

    it("refuses an identity-less reconnect onto an identity-bound account", async () => {
      const { finalizer, writer } = subject("created");

      await expect(
        finalizer.finalizeTrustedConnection(
          {
            ...authorization,
            operation: "reconnect",
            providerAccountId: winner.account.id,
            targetAccountStatus: "active",
            targetAccountLifecycleVersion: 0,
          } as ProcessingProviderAuthorization,
          { credential: { refreshToken: "new-secret" } },
          new OpenAIModelProviderAccountAdapter(),
          100_000
        )
      ).rejects.toThrow(/could not be verified/);
      expect(writer.finalizeDeviceAuthorizationReconnect).not.toHaveBeenCalled();
    });

    it("refuses an identity-less create for an identity-bound provider", async () => {
      const { finalizer, writer } = subject("created");

      await expect(
        finalizer.finalizeTrustedConnection(
          authorization,
          { credential: { refreshToken: "new-secret" } },
          new OpenAIModelProviderAccountAdapter(),
          100_000
        )
      ).rejects.toThrow(/could not be verified/);
      expect(writer.finalizeDeviceAuthorizationCreate).not.toHaveBeenCalled();
    });
  });
});
