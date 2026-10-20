import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import {
  MAX_CROSS_SESSION_MESSAGE_CHARACTERS,
  type CrossSessionDeliveryResult,
  type ToolEffectRegistration,
} from "@open-inspect/shared";

/** The effect declaration for the one tool this extension contributes. */
export const CROSS_SESSION_TOOL_EFFECT_REGISTRATIONS = [
  {
    name: "message_session",
    effect: "external_mutation",
    callers: ["model"],
    replay: "safe",
  },
] as const satisfies readonly ToolEffectRegistration[];

export interface CrossSessionToolClient {
  /**
   * Ask the owning session to hand one message to another session.
   *
   * The owning session owns the authority: it resolves the current user,
   * team, workspace, and resource authority, writes the durable receipt, and
   * only then calls the target.
   */
  send(
    request: {
      targetSessionId: string;
      content: string;
      idempotencyKey: string;
      agentConversationId: string | null;
      sourceTaskId: string | null;
    },
    signal?: AbortSignal
  ): Promise<CrossSessionDeliveryResult>;
}

export interface CrossSessionExtensionOptions {
  client: CrossSessionToolClient;
}

/**
 * The agent's cross-session coordination tool.
 *
 * The tool carries a message and nothing else. It never carries a credential,
 * never names a user it speaks for, and never reaches another session
 * directly: the owning session authorizes the delivery and the target
 * revalidates it.
 */
export function createCrossSessionExtension(options: CrossSessionExtensionOptions) {
  return defineExtension({
    name: "open-inspect.cross-session",
    sections: [
      section(
        "cross_session",
        () =>
          "Hand a bounded message to another Open-Inspect session. The target's own access rules decide whether it is delivered.",
        { tag: false }
      ),
    ],
    tools: [
      defineTool({
        name: "message_session",
        description:
          "Send a message to another Open-Inspect session you are authorized to collaborate in.",
        parameters: Type.Object({
          targetSessionId: Type.String({ minLength: 1, maxLength: 256 }),
          content: Type.String({ minLength: 1, maxLength: MAX_CROSS_SESSION_MESSAGE_CHARACTERS }),
        }),
        structuredOutputSchema: Type.Any(),
        replay: "safe",
        callers: ["model"],
        execute: async (args, api, context) => {
          const result = await options.client.send(
            {
              targetSessionId: args.targetSessionId,
              content: args.content,
              // The same tool call always produces the same request key, so a
              // replay of the turn never sends the message twice.
              idempotencyKey: `pi:${String(api.taskId)}:${api.callId}`,
              agentConversationId:
                api.conversationId === undefined ? null : String(api.conversationId),
              sourceTaskId: api.taskId === undefined ? null : String(api.taskId),
            },
            context.abortSignal
          );
          if (result.status !== "delivered" && result.status !== "duplicate") {
            return {
              isError: true,
              output: [
                {
                  type: "text" as const,
                  text: result.reason ?? "The target session refused the message",
                },
              ],
              details: { status: result.status } as Record<string, JsonValue>,
            };
          }
          return {
            isError: false,
            output: [
              {
                type: "text" as const,
                text:
                  result.status === "duplicate"
                    ? "The message was already delivered."
                    : "The message was delivered.",
              },
            ],
            structuredOutput: {
              status: result.status,
              messageId: result.messageId,
            },
            details: { receiptId: result.receiptId, status: result.status },
          };
        },
      }),
    ],
  });
}
