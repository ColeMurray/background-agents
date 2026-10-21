import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { ToolPolicyDelegate } from "../harness/tool-policy";

/** The cross-session tool's stable name. */
export const CROSS_SESSION_TOOL_NAME = "message_session";

/**
 * The session's answer to "may this turn hand a message to another session?".
 *
 * The session owns the decision. The agent learns only whether it may
 * proceed and why not; it never receives a session client.
 */
export interface CrossSessionAuthorizationDecision {
  allowed: boolean;
  code?: string;
  reason?: string;
}

export interface CrossSessionAuthorizationClient {
  authorize(signal?: AbortSignal): Promise<CrossSessionAuthorizationDecision>;
}

export interface CrossSessionPolicyOptions {
  client: CrossSessionAuthorizationClient;
}

/**
 * The cross-session policy.
 *
 * The tool's real authority is the owning session, which checks the source,
 * the actor, the target, and the receipt. This delegate is the early gate:
 * it refuses the call with a clear reason when the deployment or the session
 * has switched the capability off, so the model is not left guessing.
 */
export function createCrossSessionPolicyDelegate(
  options: CrossSessionPolicyOptions
): ToolPolicyDelegate {
  return {
    async beforeTool(call, declaration, _api, context) {
      if (call.name !== CROSS_SESSION_TOOL_NAME) return undefined;
      if (declaration.effect !== "external_mutation") return undefined;
      let decision: CrossSessionAuthorizationDecision;
      try {
        decision = await options.client.authorize(context.abortSignal);
      } catch {
        // An unexpected failure is not the agent's business. The session's
        // own reason arrives in the answer, never an internal string.
        return {
          block: "Cross-session messaging could not be authorized for this session",
        };
      }
      if (decision.allowed) return undefined;
      return {
        block: decision.reason ?? "Cross-session messaging is not available for this session",
      };
    },
  };
}

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
  ): Promise<{
    status: "delivered" | "duplicate" | "rejected";
    messageId: string | null;
    reason: string | null;
  }>;
}

export interface CrossSessionExtensionOptions {
  client: CrossSessionToolClient;
}

/**
 * The agent's cross-session coordination tool.
 *
 * The tool carries a message and nothing else. It never carries a
 * credential, never names a user it speaks for, and never reaches another
 * session directly: the owning session authorizes the delivery and the target
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
        name: CROSS_SESSION_TOOL_NAME,
        description:
          "Send a message to another Open-Inspect session you are authorized to collaborate in.",
        parameters: Type.Object({
          targetSessionId: Type.String({ minLength: 1, maxLength: 256 }),
          content: Type.String({ minLength: 1, maxLength: 8_000 }),
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
              details: { status: result.status } satisfies Record<string, JsonValue>,
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
            structuredOutput: { status: result.status, messageId: result.messageId },
            details: { status: result.status },
          };
        },
      }),
    ],
  });
}
