import {
  sandboxMemoryWriteSchema,
  type SandboxMemoryWriteInput,
} from "@open-inspect/shared/types/memories";
import { PI_MEMORY_TOOL_EFFECT_REGISTRATIONS } from "@open-inspect/shared";
import { PI_MEMORY_TOOL_NAMES } from "./memory-extension";
import type { PiToolPolicyDelegate } from "./tool-policy-types";

/**
 * The session's answer to "may this turn write this memory?".
 *
 * The session owns the decision: it resolves the target partition and the
 * session principal's current access to it. The agent learns only whether it
 * may proceed and why not.
 */
export interface MemoryWriteAuthorizationDecision {
  allowed: boolean;
  reason?: string;
}

export interface MemoryAuthorizationClient {
  authorize(
    request: SandboxMemoryWriteInput,
    signal?: AbortSignal
  ): Promise<MemoryWriteAuthorizationDecision>;
}

export interface MemoryPolicyOptions {
  client: MemoryAuthorizationClient;
}

/**
 * The memory policy.
 *
 * The write's real authority is the owning session, which resolves the
 * partition and re-checks the session's access to it. This delegate is the
 * early gate: it asks the session whether this particular write is permitted
 * and refuses the call with a clear reason when it is not, so the model is
 * not left guessing. The write itself re-checks at commit.
 */
export function createMemoryPolicyDelegate(options: MemoryPolicyOptions): PiToolPolicyDelegate {
  return {
    async beforeTool(call, declaration, _api, context) {
      if (call.name !== PI_MEMORY_TOOL_NAMES.write) return undefined;
      if (declaration.effect !== "external_mutation") return undefined;
      const parsed = sandboxMemoryWriteSchema.safeParse(call.arguments);
      // The tool's own validation reports a malformed argument; this gate
      // answers only the question of authority.
      if (!parsed.success) return undefined;
      let decision: MemoryWriteAuthorizationDecision;
      try {
        decision = await options.client.authorize(parsed.data, context.abortSignal);
      } catch {
        // An unexpected failure is not the agent's business. The session's own
        // reason arrives in the answer, never an internal string.
        return {
          block: "The memory write could not be authorized for this session",
        };
      }
      if (decision.allowed) return undefined;
      return {
        block: decision.reason ?? "This session may not write that memory",
      };
    },
  };
}

/** The tools the memory policy owns: the ones that change something. */
export const MEMORY_OWNED_TOOL_NAMES = PI_MEMORY_TOOL_EFFECT_REGISTRATIONS.filter(
  (registration) => registration.effect === "external_mutation"
).map((registration) => registration.name);
