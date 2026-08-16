import type { MessageRepository } from "./message-repository";
import type { ParticipantRepository } from "./participant-repository";
import type { SandboxRepository } from "./sandbox-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type {
  InitializeSessionInput,
  SessionInitializationStore,
} from "./session-initialization-store";
import type { SandboxRow, SessionRow } from "./types";

export interface DurableObjectSessionStoreRepositories {
  sessionCore: SessionCoreRepository;
  sandbox: SandboxRepository;
  participants: ParticipantRepository;
  messages: MessageRepository;
}

/** Async adapter over the existing Durable Object SQLite repositories. */
export class DurableObjectSessionStore implements SessionInitializationStore {
  constructor(
    private readonly repositories: DurableObjectSessionStoreRepositories,
    private readonly generateId: () => string
  ) {}

  async initializeSession(data: InitializeSessionInput): Promise<void> {
    // Preserve the existing independent write boundaries; initialization was
    // not one transaction before this adapter was introduced.
    this.repositories.sessionCore.upsertSession(data.session);
    this.repositories.sessionCore.replaceSessionRepositories(data.repositories);
    this.repositories.sandbox.createSandbox({ id: this.generateId(), ...data.sandbox });
    this.repositories.participants.createParticipant({ id: this.generateId(), ...data.owner });
  }

  async getSession(): Promise<SessionRow | null> {
    return this.repositories.sessionCore.getSession();
  }

  async getSandbox(): Promise<SandboxRow | null> {
    return this.repositories.sandbox.getSandbox();
  }

  async createPrompt(data: CreatePromptData): Promise<void> {
    // MessageRepository owns the transactionSync boundary for this operation.
    this.repositories.messages.createMessageWithAttachments(
      data.message,
      data.attachmentIds,
      data.event
    );
  }
}
