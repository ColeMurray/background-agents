import type { JsonValue } from "@earendil-works/chord";
import { Type, type Static, type ToolCall, type TSchema } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import type {
  ExternalActionPrepareRequest,
  ExternalActionStatusResponse,
} from "@open-inspect/shared";
import type { ToolEffectRegistration } from "@open-inspect/shared/pi-tool-effects";
import type { PiToolPolicyDelegate } from "./tool-policy-extension";

const POLICY_MEMO_SCHEMA = "open-inspect.external-action-policy.v1";
export interface ExternalActionPolicyClient {
  prepare(
    request: ExternalActionPrepareRequest,
    signal?: AbortSignal
  ): Promise<ExternalActionStatusResponse>;
  status(actionId: string, signal?: AbortSignal): Promise<ExternalActionStatusResponse>;
  execute(actionId: string, signal?: AbortSignal): Promise<ExternalActionStatusResponse>;
}

type PolicyMemo = {
  schema: typeof POLICY_MEMO_SCHEMA;
  actionId: string;
};

interface ExternalActionPolicyOptions {
  client: ExternalActionPolicyClient;
  externalActions: Readonly<
    Record<
      string,
      (call: ToolCall) => ExternalActionPrepareRequest | Promise<ExternalActionPrepareRequest>
    >
  >;
  /**
   * Live deployment gate for a new external effect.
   *
   * Only a new prepare is gated. An effect that is already prepared keeps its
   * status, its approval, and its reconciliation reachable, so an emergency
   * deny never strands work that was already admitted.
   */
  authorizeNewEffect?(
    signal?: AbortSignal
  ): Promise<{ allowed: boolean; reason?: string } | undefined>;
}

export interface GatewayExternalActionToolDefinition<TParameters extends TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  prepare(
    arguments_: Static<TParameters>,
    toolCallId: string
  ): ExternalActionPrepareRequest | Promise<ExternalActionPrepareRequest>;
}

/**
 * Credential-free Pi tool whose execution implementation can only ask SessionDO
 * to execute the action prepared by the mandatory policy hook.
 */
export function createGatewayExternalActionTool<TParameters extends TSchema>(
  definition: GatewayExternalActionToolDefinition<TParameters>,
  client: ExternalActionPolicyClient
) {
  const registration = {
    name: definition.name,
    effect: "external_mutation",
    callers: ["model", "tools"],
    replay: "safe",
  } as const satisfies ToolEffectRegistration;
  const describe = (call: ToolCall) =>
    definition.prepare(call.arguments as Static<TParameters>, call.id);
  const tool = defineTool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    structuredOutputSchema: Type.Any(),
    replay: registration.replay,
    callers: registration.callers,
    execute: async (_arguments, api, context) => {
      const memo = await api.memo<PolicyMemo>(
        `open-inspect:external-action:${api.callId}`,
        context
      );
      if (!memo) return policyError("External action has no durable policy memo");
      const status = await client.execute(memo.actionId, context.abortSignal);
      if (status.action.state !== "succeeded") {
        return policyError(
          `External action ${memo.actionId} is ${status.action.state}; its effect is not confirmed`
        );
      }
      return {
        isError: false,
        output: [
          {
            type: "text" as const,
            text: JSON.stringify(status.action.publicResult ?? { confirmed: true }),
          },
        ],
        structuredOutput: status.action.publicResult ?? { confirmed: true },
        details: { actionId: memo.actionId, state: status.action.state },
      };
    },
  });
  return { tool, describe, registration };
}

/**
 * Mandatory Pi policy. Read tools are explicitly allowlisted; every external
 * effect must first obtain a SessionDO action document and refresh its live authority.
 */
export function createExternalActionPolicyDelegate(
  options: ExternalActionPolicyOptions
): PiToolPolicyDelegate {
  return {
    beforeTool: async (call, declaration, api, context) => {
      if (declaration.effect !== "external_mutation") return undefined;
      const describe = options.externalActions[call.name];
      if (!describe) return { block: "Open-Inspect policy does not authorize this tool" };
      const memoName = memoKey(call);
      let memo = await api.memo<PolicyMemo>(memoName, context);
      let status: ExternalActionStatusResponse;
      if (!memo) {
        // A new external effect needs live deployment authority. The check
        // runs before the prepare, so a denied deployment never leaves a
        // prepared effect behind.
        const admission = await options.authorizeNewEffect?.(context.abortSignal);
        if (admission && !admission.allowed) {
          return {
            block:
              admission.reason ??
              "External actions are disabled for new effects by deployment policy",
          };
        }
        status = await options.client.prepare(await describe(call), context.abortSignal);
        memo = await api.memo(
          memoName,
          { schema: POLICY_MEMO_SCHEMA, actionId: status.action.id } satisfies PolicyMemo,
          context
        );
      } else {
        status = await options.client.status(memo.actionId, context.abortSignal);
      }
      return beforeDecision(status);
    },
    afterTool: async (call, declaration, result, api, context) => {
      if (declaration.effect !== "external_mutation") return result;
      const describe = options.externalActions[call.name];
      if (!describe) return result;
      const memo = await api.memo<PolicyMemo>(memoKey(call), context);
      if (!memo) return policyError("External action has no durable policy memo");
      let status: ExternalActionStatusResponse;
      try {
        status = await options.client.status(memo.actionId, context.abortSignal);
      } catch {
        return policyError(
          `External action ${memo.actionId} could not be confirmed after execution`
        );
      }
      if (status.action.state === "succeeded") return result;
      return policyError(
        `External action ${memo.actionId} is ${status.action.state}; its effect is not confirmed`
      );
    },
  };
}

function memoKey(call: ToolHookCall): string {
  return `open-inspect:external-action:${call.id}`;
}

function beforeDecision(status: ExternalActionStatusResponse): { block: string } | undefined {
  switch (status.action.state) {
    case "approved":
    case "succeeded":
      return undefined;
    case "awaiting_approval":
      return { block: `External action is awaiting approval (${status.action.id})` };
    default:
      return { block: `External action ${status.action.id} is ${status.action.state}` };
  }
}

function policyError(message: string): ToolExecutionResult {
  return {
    isError: true,
    output: [{ type: "text", text: message }],
    details: { policy: POLICY_MEMO_SCHEMA } satisfies Record<string, JsonValue>,
  };
}
