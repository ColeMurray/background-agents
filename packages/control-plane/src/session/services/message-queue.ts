/**
 * MessageQueue implementation.
 */

import type { MessageQueue } from "./types";
import type { MessageRepository, ParticipantRepository } from "../repository/types";
import type { PromptCommand } from "../types";

interface MessageQueueDependencies {
  messageRepo: MessageRepository;
  participantRepo: ParticipantRepository;
  getSession: () => { model?: string } | null;
  sendToSandbox: (command: PromptCommand) => Promise<void>;
  spawnIfNeeded: () => Promise<void>;
}

/**
 * Create a MessageQueue instance.
 */
export function createMessageQueue(deps: MessageQueueDependencies): MessageQueue {
  const { messageRepo, participantRepo, getSession, sendToSandbox, spawnIfNeeded } = deps;

  return {
    async enqueue(data: {
      content: string;
      authorId: string;
      source: string;
      attachments?: Array<{ type: string; name: string; url?: string }>;
      callbackContext?: {
        channel: string;
        threadTs: string;
        repoFullName: string;
        model: string;
      };
    }): Promise<string> {
      const messageId = crypto.randomUUID();
      const now = Date.now();

      messageRepo.create({
        id: messageId,
        authorId: data.authorId,
        content: data.content,
        source: data.source,
        attachments: data.attachments ? JSON.stringify(data.attachments) : null,
        callbackContext: data.callbackContext ? JSON.stringify(data.callbackContext) : null,
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

        // Spawn sandbox if needed (before marking as processing)
        await spawnIfNeeded();

        // Update message status to processing
        messageRepo.updateStatus(nextMessage.id, "processing", {
          startedAt: Date.now(),
        });

        // Get author information
        const author = participantRepo.getById(nextMessage.author_id);

        // Get session for default model
        const session = getSession();

        // Build prompt command with model and attachments
        const command: PromptCommand = {
          type: "prompt",
          messageId: nextMessage.id,
          content: nextMessage.content,
          model: nextMessage.model || session?.model || "claude-haiku-4-5",
          author: {
            userId: author?.user_id ?? "unknown",
            githubName: author?.github_name ?? null,
            githubEmail: author?.github_email ?? null,
          },
          attachments: nextMessage.attachments ? JSON.parse(nextMessage.attachments) : undefined,
        };

        // Send command to sandbox
        await sendToSandbox(command);
      } catch (error) {
        console.error("Failed to process message queue:", error);
      }
    },
  };
}
