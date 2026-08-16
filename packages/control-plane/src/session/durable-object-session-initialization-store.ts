import type { ParticipantRepository } from "./participant-repository";
import type { SandboxRepository } from "./sandbox-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type {
  InitializeSessionInput,
  SessionInitializationStore,
} from "./session-initialization-store";

export interface DurableObjectSessionInitializationStoreRepositories {
  sessionCore: SessionCoreRepository;
  sandbox: SandboxRepository;
  participants: ParticipantRepository;
}

/** Async adapter over the existing Durable Object SQLite repositories. */
export class DurableObjectSessionInitializationStore implements SessionInitializationStore {
  constructor(
    private readonly repositories: DurableObjectSessionInitializationStoreRepositories,
    private readonly generateId: () => string
  ) {}

  async initializeSession(input: InitializeSessionInput): Promise<void> {
    // Preserve the existing independent write boundaries; initialization was
    // not one transaction before this adapter was introduced.
    const primaryRepository = input.repositories[0] ?? null;
    this.repositories.sessionCore.upsertSession({
      id: input.sessionId,
      sessionName: input.sessionName,
      title: input.title,
      repoOwner: primaryRepository?.repoOwner ?? null,
      repoName: primaryRepository?.repoName ?? null,
      repoId: primaryRepository?.repoId ?? null,
      baseBranch: primaryRepository?.baseBranch ?? null,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      status: "created",
      parentSessionId: input.parentSessionId,
      spawnSource: input.spawnSource,
      spawnDepth: input.spawnDepth,
      codeServerEnabled: input.codeServerEnabled,
      vncEnabled: input.vncEnabled,
      sandboxSettings: input.sandboxSettings ? JSON.stringify(input.sandboxSettings) : null,
      environmentId: input.environmentId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    this.repositories.sessionCore.replaceSessionRepositories(input.repositories);
    this.repositories.sandbox.createSandbox({
      id: this.generateId(),
      status: "pending",
      gitSyncStatus: "pending",
      createdAt: 0,
    });
    this.repositories.participants.createParticipant({
      id: this.generateId(),
      ...input.owner,
      role: "owner",
      joinedAt: input.createdAt,
    });
  }
}
