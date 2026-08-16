import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";

export interface SessionInitializationRepository {
  position: number;
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string;
}

export interface SessionInitializationOwner {
  userId: string;
  canonicalUserId?: string | null;
  scmUserId?: string | null;
  scmLogin?: string | null;
  scmName?: string | null;
  scmEmail?: string | null;
  scmAccessTokenEncrypted?: string | null;
  scmRefreshTokenEncrypted?: string | null;
  scmTokenExpiresAt?: number | null;
}

/** Domain state required to initialize a session and its owner. */
export interface InitializeSessionInput {
  sessionId: string;
  sessionName: string;
  title: string | null;
  repositories: SessionInitializationRepository[];
  model: string;
  reasoningEffort: string | null;
  parentSessionId: string | null;
  spawnSource: SpawnSource;
  spawnDepth: number;
  codeServerEnabled: boolean;
  vncEnabled: boolean;
  sandboxSettings: SandboxSettings | null;
  environmentId: string | null;
  owner: SessionInitializationOwner;
  createdAt: number;
}

/** Platform-neutral persistence capability used by session initialization. */
export interface SessionInitializationStore {
  initializeSession(input: InitializeSessionInput): Promise<void>;
}
