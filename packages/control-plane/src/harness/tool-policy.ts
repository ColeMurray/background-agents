import type { ToolEffectRegistration } from "@open-inspect/shared/tool-effects";
import type { HarnessActionCeiling } from "./action-ceiling";

/**
 * The default-deny policy over the exact effect registry assembled for a
 * runtime.
 *
 * The seam decides; the adapter installs. A tool call is decided here — is the
 * tool declared, may this caller call it, is the deployment closed, has a
 * feature delegate spoken, may the turn do one more thing — and the adapter
 * turns that decision into its own runtime's hook.
 *
 * Nothing here names a runtime, a model SDK, or a harness. The runtime's own
 * shapes arrive as type parameters, so the policy is the same policy whatever
 * runs it.
 */

export const TOOL_POLICY_EXTENSION_NAME = "open-inspect.tool-policy";

/** The facts the seam's own decision needs about a call. */
export interface HarnessToolCall {
  /** The tool's name. */
  readonly name: string;
  /** Who made the call: the model, or another tool. */
  readonly caller: "model" | "tools";
}

/** The part of a turn's context the seam reads. */
export interface HarnessToolContext {
  readonly abortSignal: AbortSignal | undefined;
}

/** Feature-specific decisions composed behind the one canonical policy. */
export interface ToolPolicyDelegate<
  Call = unknown,
  Api = unknown,
  Context extends HarnessToolContext = HarnessToolContext,
  Result = unknown,
> {
  beforeTool?(
    call: Call,
    declaration: ToolEffectRegistration,
    api: Api,
    context: Context
  ): { readonly block: string } | undefined | Promise<{ readonly block: string } | undefined>;
  memoFinalAllow?(
    call: Call,
    declaration: ToolEffectRegistration,
    api: Api,
    context: Context
  ): void | Promise<void>;
  afterTool?(
    call: Call,
    declaration: ToolEffectRegistration,
    result: Result,
    api: Api,
    context: Context
  ): Result | Promise<Result>;
}

/** Broad deployment denial, which runs before the feature delegates. */
export interface ToolEmergencyPolicy<
  Call = unknown,
  Api = unknown,
  Context extends HarnessToolContext = HarnessToolContext,
> {
  beforeFeatureDelegates(
    call: Call,
    declaration: ToolEffectRegistration,
    api: Api,
    context: Context
  ): { readonly block: string } | undefined | Promise<{ readonly block: string } | undefined>;
}

/** The inputs of the one canonical policy. */
export interface HarnessToolPolicyOptions<
  Call = unknown,
  Api = unknown,
  Context extends HarnessToolContext = HarnessToolContext,
  Result = unknown,
> {
  /** The exact effect registry the runtime exposes. */
  readonly effects: ReadonlyMap<string, ToolEffectRegistration>;
  /** The feature-specific decisions, in order. */
  readonly delegates?: readonly ToolPolicyDelegate<Call, Api, Context, Result>[];
  /** The deployment's kill switch, which runs before the delegates. */
  readonly emergencyPolicy?: ToolEmergencyPolicy<Call, Api, Context>;
  /**
   * The ceiling on what this turn may do.
   *
   * A harness with no sandbox has no wall, so the count is the wall. The
   * ceiling is read through a getter because it is per *turn*, and the policy
   * is installed once.
   */
  readonly ceiling?: () => HarnessActionCeiling;
  /** The facts about a call that the seam's own decision needs. */
  readonly factsOf: (call: Call) => HarnessToolCall;
  /** The result to return when the policy fails closed. */
  readonly failureResult: (message: string) => Result;
  /** Whether an error is the turn's own cancellation. */
  readonly isCancellation?: (error: unknown, context: Context) => boolean;
}

/** The hooks the one canonical policy installs. */
export interface HarnessToolPolicyHooks<
  Call = unknown,
  Api = unknown,
  Context extends HarnessToolContext = HarnessToolContext,
  Result = unknown,
> {
  beforeTool(
    call: Call,
    api: Api,
    context: Context
  ): Promise<{ readonly block: string } | undefined>;
  afterTool(call: Call, result: Result, api: Api, context: Context): Promise<Result>;
}

/**
 * The one canonical policy.
 *
 * The order is fixed and it is the order that matters: the tool must be
 * declared, the turn must have something left to do, the caller must be one the
 * declaration allows, the deployment must not be closed, and only then do the
 * feature delegates speak. The allow memos are written last, and only when
 * every delegate allowed the call.
 */
export function createToolPolicy<
  Call = unknown,
  Api = unknown,
  Context extends HarnessToolContext = HarnessToolContext,
  Result = unknown,
>(options: HarnessToolPolicyOptions<Call, Api, Context, Result>): HarnessToolPolicyHooks<
  Call,
  Api,
  Context,
  Result
> {
  const {
    effects,
    delegates = [],
    emergencyPolicy,
    ceiling,
    factsOf,
    failureResult,
    isCancellation,
  } = options;

  return {
    async beforeTool(call, api, context) {
      const facts = factsOf(call);
      const declaration = effects.get(facts.name);
      if (!declaration) return { block: `Tool is not declared: ${facts.name}` };

      const limit = ceiling?.();
      if (limit && limit.remaining() <= 0) {
        return { block: "This turn has reached the action ceiling" };
      }
      limit?.consume();

      if (!declaration.callers.includes(facts.caller)) {
        return { block: `Tool caller is not allowed: ${facts.caller} -> ${facts.name}` };
      }

      const emergencyDecision = await emergencyPolicy?.beforeFeatureDelegates(
        call,
        declaration,
        api,
        context
      );
      if (emergencyDecision !== undefined) return emergencyDecision;

      for (const delegate of delegates) {
        const decision = await delegate.beforeTool?.(call, declaration, api, context);
        if (decision !== undefined) return decision;
      }
      for (const delegate of delegates) {
        await delegate.memoFinalAllow?.(call, declaration, api, context);
      }
      return undefined;
    },

    async afterTool(call, result, api, context) {
      const facts = factsOf(call);
      const declaration = effects.get(facts.name);
      if (!declaration) return failureResult(`Tool is not declared: ${facts.name}`);

      let next = result;
      for (const delegate of delegates) {
        if (!delegate.afterTool) continue;
        try {
          next = await delegate.afterTool(call, declaration, next, api, context);
        } catch (error) {
          if (isCancellation?.(error, context)) throw error;
          return failureResult("Tool policy failed closed");
        }
      }
      return next;
    },
  };
}
