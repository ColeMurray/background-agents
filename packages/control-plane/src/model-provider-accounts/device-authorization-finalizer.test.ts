import { describe, expect, it, vi } from "vitest";
import { OpenAIModelProviderAccountAdapter } from "../auth/model-provider-account-openai-adapter";
import type { ProcessingProviderAuthorization } from "../db/provider-account-authorizations";
import type { ModelProviderAccountLifecycleSnapshot } from "../db/model-provider-accounts";
import { ProviderDeviceAuthorizationFinalizer } from "./device-authorization-finalizer";

const authorization: ProcessingProviderAuthorization = {
  id: "01".repeat(32),
  userId: "user-1",
  provider: "openai",
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
});
