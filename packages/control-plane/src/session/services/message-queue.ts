/**
 * MessageQueue implementation.
 */

import type { MessageQueue } from "./types";
import type { MessageRepository, ParticipantRepository } from "../repository/types";

interface MessageQueueDependencies {
  messageRepo: MessageRepository;
  participantRepo: ParticipantRepository;
  sendToSandbox: (command: SandboxCommand) => Promise<void>;
  spawnIfNeeded: () => Promise<void>;
}

interface SandboxCommand {
  id: string;
  content: string;
  author: {
    id: string;
    githubLogin?: string | null;
    githubName?: string | null;
  };
  source: string;
}

/**
 * Create a MessageQueue instance.
 */
export function createMessageQueue(deps: MessageQueueDependencies): MessageQueue {
  const { messageRepo, participantRepo, sendToSandbox, spawnIfNeeded } = deps;

  return {
    async enqueue(data: { content: string; authorId: string; source: string }): Promise<string> {
      const messageId = crypto.randomUUID();
      const now = Date.now();

      messageRepo.create({
        id: messageId,
        authorId: data.authorId,
        content: data.content,
        source: data.source,
        status: "pending",
        createdAt: now,
      });

      return messageId;
    },

    async processQueue(): Promise<void> {
      try {
        // Check if there's already a message being processed
        const processing = messageRepo.getProcessing();
        if (processing) {
          return;
        }

        // Get the next pending message (FIFO)
        const nextMessage = messageRepo.getNextPending();
        if (!nextMessage) {
          return;
        }

        // Update message status to processing
        messageRepo.updateStatus(nextMessage.id, "processing", {
          startedAt: Date.now(),
        });

        // Get author information
        const author = participantRepo.getById(nextMessage.author_id);

        // Build sandbox command
        const command: SandboxCommand = {
          id: nextMessage.id,
          content: nextMessage.content,
          author: {
            id: nextMessage.author_id,
            githubLogin: author?.github_login,
            githubName: author?.github_name,
          },
          source: nextMessage.source,
        };

        // Spawn sandbox if needed
        await spawnIfNeeded();

        // Send command to sandbox
        await sendToSandbox(command);
      } catch (error) {
        console.error("Failed to process message queue:", error);
      }
    },
  };
}
