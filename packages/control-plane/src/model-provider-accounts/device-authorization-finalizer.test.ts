import { describe, expect, it, vi } from "vitest";
import { OpenAIModelProviderAccountAdapter } from "../auth/model-provider-account-openai-adapter";
import type { ProcessingProviderAuthorization } from "../db/provider-account-authorizations";
import type { ModelProviderAccountLifecycleSnapshot } from "../db/model-provider-accounts";
import { ProviderDeviceAuthorizationFinalizer } from "./device-authorization-finalizer";

const authorization: ProcessingProviderAuthorization & { operation: "create" } = {
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
    externalPrincipalId: null,
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

describe("ProviderDeviceAuthorizationFinalizer seat identity", () => {
  const WORKSPACE = "workspace-1";

  function seatedAccount(
    id: string,
    externalPrincipalId: string | null
  ): ModelProviderAccountLifecycleSnapshot {
    return {
      account: { ...winner.account, id, externalAccountId: WORKSPACE, externalPrincipalId },
      lifecycleVersion: 0,
    };
  }

  /** Store that resolves accounts by the full identity, the way D1 does. */
  function seatStore(stored: ModelProviderAccountLifecycleSnapshot[]) {
    return {
      getLifecycleSnapshot: vi.fn(async (id: string) => stored.find((s) => s.account.id === id)!),
      findLifecycleSnapshotByExternalIdentity: vi.fn(
        async (_provider: string, externalAccountId: string, seat: string | null) =>
          stored.find(
            (s) =>
              s.account.externalAccountId === externalAccountId &&
              s.account.externalPrincipalId === seat
          ) ?? null
      ),
    };
  }

  function finalizerFor(accounts: ReturnType<typeof seatStore>) {
    const writer = {
      finalizeDeviceAuthorizationCreate: vi.fn(async () => ({ type: "created" as const })),
      finalizeDeviceAuthorizationReconnect: vi.fn(async () => ({ type: "connected" as const })),
    };
    return {
      writer,
      finalizer: new ProviderDeviceAuthorizationFinalizer(accounts, writer, () => "04".repeat(16)),
    };
  }

  const adapter = new OpenAIModelProviderAccountAdapter();

  it("gives a second seat on one subscription its own account", async () => {
    const accounts = seatStore([seatedAccount("account-a", "user-a")]);
    const { finalizer, writer } = finalizerFor(accounts);

    await expect(
      finalizer.finalizeTrustedConnection(
        authorization,
        {
          credential: { refreshToken: "seat-b-secret" },
          externalAccountId: WORKSPACE,
          externalPrincipalId: "user-b",
          externalPrincipalLabel: "seat-b@example.com",
        },
        adapter,
        100_000
      )
    ).resolves.toBe(true);

    expect(writer.finalizeDeviceAuthorizationReconnect).not.toHaveBeenCalled();
    expect(writer.finalizeDeviceAuthorizationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        externalAccountId: WORKSPACE,
        externalPrincipalId: "user-b",
        displayName: "seat-b@example.com",
      })
    );
  });

  it("adopts an account whose seat was never recorded instead of duplicating it", async () => {
    const accounts = seatStore([seatedAccount("account-legacy", null)]);
    const { finalizer, writer } = finalizerFor(accounts);

    await expect(
      finalizer.finalizeTrustedConnection(
        authorization,
        {
          credential: { refreshToken: "seat-a-secret" },
          externalAccountId: WORKSPACE,
          externalPrincipalId: "user-a",
        },
        adapter,
        100_000
      )
    ).resolves.toBe(true);

    expect(writer.finalizeDeviceAuthorizationCreate).not.toHaveBeenCalled();
    expect(writer.finalizeDeviceAuthorizationReconnect).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-legacy", externalPrincipalId: "user-a" })
    );
  });

  it("refuses a reconnect authorized by a different seat on the same subscription", async () => {
    const accounts = seatStore([seatedAccount("account-a", "user-a")]);
    const { finalizer, writer } = finalizerFor(accounts);

    await expect(
      finalizer.finalizeTrustedConnection(
        {
          ...authorization,
          operation: "reconnect",
          providerAccountId: "account-a",
          targetAccountStatus: "active",
          targetAccountLifecycleVersion: 0,
        },
        {
          credential: { refreshToken: "seat-b-secret" },
          externalAccountId: WORKSPACE,
          externalPrincipalId: "user-b",
        },
        adapter,
        100_000
      )
    ).rejects.toThrow("Provider account identity did not match");

    expect(writer.finalizeDeviceAuthorizationReconnect).not.toHaveBeenCalled();
  });
});
