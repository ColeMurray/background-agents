/**
 * PRCreator implementation.
 */

import type { PRCreator } from "./types";
import type {
  MessageRepository,
  ParticipantRepository,
  ArtifactRepository,
} from "../repository/types";
import type { ParticipantRow } from "../types";
import type { GitHubPort } from "../../ports/github-port";

interface PRCreatorDependencies {
  messageRepo: MessageRepository;
  participantRepo: ParticipantRepository;
  artifactRepo: ArtifactRepository;
  getSandboxWebSocket: () => WebSocket | null;
  safeSend: (ws: WebSocket, message: unknown) => boolean;
  registerPushPromise: (
    branchName: string,
    resolve: () => void,
    reject: (err: Error) => void
  ) => { timeoutId: ReturnType<typeof setTimeout> };
  broadcast: (message: unknown) => void;
  github: GitHubPort;
}

/**
 * Create a PRCreator instance.
 */
export function createPRCreator(deps: PRCreatorDependencies): PRCreator {
  const {
    messageRepo,
    participantRepo,
    artifactRepo,
    getSandboxWebSocket,
    safeSend,
    registerPushPromise,
    broadcast,
    github,
  } = deps;

  return {
    async getPromptingUser(): Promise<
      | { user: ParticipantRow; error?: never; status?: never }
      | { user?: never; error: string; status: number }
    > {
      // Find the currently processing message
      const processingMessage = messageRepo.getProcessing();

      if (!processingMessage) {
        console.log("[PRCreator] No processing message found");
        return {
          error: "No active prompt found. PR creation must be triggered by a user prompt.",
          status: 400,
        };
      }

      const participantId = processingMessage.author_id;

      // Get the participant record
      const participant = participantRepo.getById(participantId);

      if (!participant) {
        console.log(`[PRCreator] Participant not found for id=${participantId}`);
        return { error: "User not found. Please re-authenticate.", status: 401 };
      }

      if (!participant.github_access_token_encrypted) {
        console.log(`[PRCreator] No GitHub token for user_id=${participant.user_id}`);
        return {
          error:
            "Your GitHub token is not available for PR creation. Please reconnect to the session to re-authenticate.",
          status: 401,
        };
      }

      if (this.isTokenExpired(participant)) {
        console.log(`[PRCreator] GitHub token expired for user_id=${participant.user_id}`);
        return { error: "Your GitHub token has expired. Please re-authenticate.", status: 401 };
      }

      return { user: participant };
    },

    isTokenExpired(participant: ParticipantRow, bufferMs = 60000): boolean {
      if (!participant.github_token_expires_at) {
        return false; // No expiration set, assume valid
      }
      return Date.now() + bufferMs >= participant.github_token_expires_at;
    },

    async pushBranch(data: {
      branchName: string;
      repoOwner: string;
      repoName: string;
      githubToken?: string;
    }): Promise<{ success: true } | { success: false; error: string }> {
      const sandboxWs = getSandboxWebSocket();

      if (!sandboxWs) {
        // No sandbox connected - user may have already pushed manually
        console.log("[PRCreator] No sandbox connected, assuming branch was pushed manually");
        return { success: true };
      }

      // Create a promise that will be resolved when push_complete event arrives
      let storedTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const pushPromise = new Promise<void>((resolve, reject) => {
        const { timeoutId } = registerPushPromise(data.branchName, resolve, reject);
        storedTimeoutId = timeoutId;
      });

      // Tell sandbox to push the current branch
      console.log(`[PRCreator] Sending push command for branch ${data.branchName}`);
      safeSend(sandboxWs, {
        type: "push",
        branchName: data.branchName,
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        githubToken: data.githubToken,
      });

      // Wait for push_complete or push_error event
      try {
        await pushPromise;
        console.log(`[PRCreator] Push completed successfully for branch ${data.branchName}`);
        return { success: true };
      } catch (pushError) {
        console.error(`[PRCreator] Push failed: ${pushError}`);
        return { success: false, error: `Failed to push branch: ${pushError}` };
      } finally {
        // Clean up timeout to prevent memory leaks
        if (storedTimeoutId) {
          clearTimeout(storedTimeoutId);
        }
      }
    },

    async createPR(data: {
      title: string;
      body: string;
      baseBranch: string;
      headBranch: string;
      repoOwner: string;
      repoName: string;
      userToken: string;
    }): Promise<{ prNumber: number; prUrl: string; state: string }> {
      // Create the PR using GitHub API
      const prResult = await github.createPullRequest({
        accessTokenEncrypted: data.userToken,
        owner: data.repoOwner,
        repo: data.repoName,
        title: data.title,
        body: data.body,
        head: data.headBranch,
        base: data.baseBranch,
      });

      // Store the PR as an artifact
      const artifactId = crypto.randomUUID();
      const now = Date.now();
      artifactRepo.create({
        id: artifactId,
        type: "pr",
        url: prResult.htmlUrl,
        metadata: JSON.stringify({
          number: prResult.number,
          state: prResult.state,
          head: data.headBranch,
          base: data.baseBranch,
        }),
        createdAt: now,
      });

      // Broadcast PR creation to all clients
      broadcast({
        type: "artifact_created",
        artifact: {
          id: artifactId,
          type: "pr",
          url: prResult.htmlUrl,
          prNumber: prResult.number,
        },
      });

      return {
        prNumber: prResult.number,
        prUrl: prResult.htmlUrl,
        state: prResult.state,
      };
    },
  };
}
