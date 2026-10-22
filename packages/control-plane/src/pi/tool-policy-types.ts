import type { Context } from "@earendil-works/chord";
import type {
  HookApi,
  ToolExecutionResult,
  ToolHookCall,
} from "@earendil-works/pi-durable";
import type { ToolEmergencyPolicy, ToolPolicyDelegate } from "../harness/tool-policy";

/**
 * The runtime's own shapes, bound to the seam's ports.
 *
 * The seam's policy is the same policy whatever runs it: the runtime's call,
 * its hook API, its context and its result arrive as type parameters. This
 * file is where the Pi runtime's shapes are bound, so that every policy in
 * this directory speaks about the same four things.
 */

/** A feature-specific decision about one tool call. */
export type PiToolPolicyDelegate = ToolPolicyDelegate<
  ToolHookCall,
  HookApi,
  Context,
  ToolExecutionResult
>;

/** The deployment's kill switch, in the runtime's own shapes. */
export type PiToolEmergencyPolicy = ToolEmergencyPolicy<ToolHookCall, HookApi, Context>;
