/**
 * PRCreator implementation.
 */

import type { PRCreator } from "./types";
import type { ParticipantRepository, ArtifactRepository } from "../repository/types";
import type { ParticipantRow } from "../types";

interface PRCreatorDependencies {
  participantRepo: ParticipantRepository;
  artifactRepo: ArtifactRepository;
  sendToSandbox: (command: { type: string; branch: string }) => Promise<void>;
  createGitHubPR: (data: {
    branch: string;
    title: string;
    body: string;
    token: string;
  }) => Promise<{ number: number; html_url: string }>;
}

/**
 * Create a PRCreator instance.
 */
export function createPRCreator(deps: PRCreatorDependencies): PRCreator {
  const { participantRepo, artifactRepo, sendToSandbox, createGitHubPR } = deps;

  return {
    async createPullRequest(data: { branch: string; title: string; body: string }): Promise<void> {
      // Find participant with valid GitHub token
      const participant = this.findParticipantWithToken();
      if (!participant || !participant.github_access_token_encrypted) {
        throw new Error("No participant with valid GitHub token found");
      }

      // Send push command to sandbox
      await sendToSandbox({
        type: "push_branch",
        branch: data.branch,
      });

      // Create PR via GitHub API
      const pr = await createGitHubPR({
        branch: data.branch,
        title: data.title,
        body: data.body,
        token: participant.github_access_token_encrypted,
      });

      // Store PR artifact
      artifactRepo.create({
        id: crypto.randomUUID(),
        type: "pull_request",
        url: pr.html_url,
        metadata: JSON.stringify({
          number: pr.number,
          branch: data.branch,
          title: data.title,
        }),
        createdAt: Date.now(),
      });
    },

    findParticipantWithToken(): ParticipantRow | null {
      const participants = participantRepo.list();

      for (const participant of participants) {
        if (participant.github_access_token_encrypted) {
          return participant;
        }
      }

      return null;
    },
  };
}
