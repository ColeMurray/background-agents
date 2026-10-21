import { harnessMemoryToolName } from "./memory-tools";

/** Where a Pi tool can cause observable work. This is metadata only. */
export const TOOL_EFFECT_KINDS = [
  "local_read",
  "local_mutation",
  "external_read",
  "external_mutation",
  "sandbox_execution",
  "control",
] as const;

export type ToolEffectKind = (typeof TOOL_EFFECT_KINDS)[number];

/** Canonical effect classification for any exposed sandbox process execution. */
export const SANDBOX_EXECUTION_TOOL_EFFECT = "sandbox_execution" satisfies ToolEffectKind;

/** Pi Durable callers which may invoke a registered tool. */
export const TOOL_CALLERS = ["model", "tools"] as const;

export type ToolCaller = (typeof TOOL_CALLERS)[number];

/** Pi Durable replay declarations. */
export const TOOL_REPLAY_POLICIES = ["safe", "unsafe"] as const;

export type ToolReplayPolicy = (typeof TOOL_REPLAY_POLICIES)[number];

export interface ToolEffectRegistration {
  readonly name: string;
  readonly effect: ToolEffectKind;
  readonly callers: readonly ToolCaller[];
  readonly replay: ToolReplayPolicy;
}

/**
 * Effect declarations for the stable Pi tools that predate feature extensions.
 * PiSessionDO selects declarations from this catalog for each active contribution;
 * assembleExtensions composes the exact runtime registry.
 */
export const PI_TOOL_EFFECT_REGISTRATIONS = [
  {
    name: "repository_list",
    effect: "external_read",
    callers: ["model", "tools"],
    replay: "safe",
  },
  {
    name: "repository_read",
    effect: "external_read",
    callers: ["model", "tools"],
    replay: "safe",
  },
  { name: "subagent", effect: "control", callers: ["model"], replay: "safe" },
  { name: "read", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
  { name: "ls", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
  { name: "find", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
  { name: "grep", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
  { name: "activate_skill", effect: "control", callers: ["model", "tools"], replay: "safe" },
  {
    name: "read_skill_resource",
    effect: "local_read",
    callers: ["model", "tools"],
    replay: "safe",
  },
] as const satisfies readonly ToolEffectRegistration[];

/** Declarations that must accompany Pi Durable's native Code Mode extension. */
/**
 * The Code Mode tool.
 *
 * The extension is created with `models: false`, so a script has no model
 * catalog and no model-call tools: sending model-written context to the
 * provider with the session's credential is exactly what a capability must
 * never do. Those tools are therefore not part of Pi's surface at all, and
 * are not declared here.
 */
export const PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS = [
  {
    name: "codemode",
    effect: "sandbox_execution",
    callers: ["model"],
    replay: "safe",
  },
] as const satisfies readonly ToolEffectRegistration[];

export const PI_SANDBOX_EXECUTION_TOOL_EFFECT_REGISTRATIONS = [
  {
    name: "run_shell",
    effect: SANDBOX_EXECUTION_TOOL_EFFECT,
    callers: ["model"],
    replay: "safe",
  },
  {
    name: "run_build",
    effect: SANDBOX_EXECUTION_TOOL_EFFECT,
    callers: ["model"],
    replay: "safe",
  },
  {
    name: "run_tests",
    effect: SANDBOX_EXECUTION_TOOL_EFFECT,
    callers: ["model"],
    replay: "safe",
  },
] as const satisfies readonly ToolEffectRegistration[];

/**
 * Computer's isolated JavaScript backend. It is contributed only when the
 * deployment supplies a Worker Loader and the session's canonical sandbox
 * execution capability is enabled. Keeping it separate prevents
 * createPiTools' default of exposing every registered backend.
 */
export const PI_COMPUTER_EXEC_TOOL_EFFECT_REGISTRATIONS = [
  {
    name: "exec",
    effect: SANDBOX_EXECUTION_TOOL_EFFECT,
    callers: ["model"],
    replay: "unsafe",
  },
] as const satisfies readonly ToolEffectRegistration[];

/**
 * The MCP read tools.
 *
 * They are declared here, before any extension is assembled, so the assembler
 * knows their effect without asking the session. The tools are read-only: an
 * MCP mutation never becomes a tool, it becomes an external action that a
 * person approves.
 *
 * There are two, not one, because the two lanes are different credential
 * domains: `mcp_read_shared` reads through the deployment's own server
 * credential, scoped by the session's repositories, and `mcp_read_connection`
 * reads through one person's OAuth connection. One model-visible tool that
 * spans both would let the model confuse a deployment-wide read with a
 * person's, which no other harness's MCP surface allows.
 */
export const PI_MCP_TOOL_EFFECT_REGISTRATIONS = [
  {
    name: "mcp_read_shared",
    effect: "external_read",
    callers: ["model"],
    replay: "safe",
  },
  {
    name: "mcp_read_connection",
    effect: "external_read",
    callers: ["model"],
    replay: "safe",
  },
] as const satisfies readonly ToolEffectRegistration[];

/**
 * The cross-session messaging tool.
 *
 * It changes something outside the model, so it is owned by the cross-session
 * policy delegate and authorized by the owning session on every call.
 */
export const CROSS_SESSION_TOOL_EFFECT_REGISTRATIONS = [
  {
    name: "message_session",
    effect: "external_mutation",
    callers: ["model"],
    replay: "safe",
  },
] as const satisfies readonly ToolEffectRegistration[];

/**
 * The browser tool.
 *
 * Driving a browser is not replay-safe: a replayed run would navigate again.
 * The tool is declared here, before any extension is assembled, so the
 * assembler knows its effect without asking the session.
 *
 * Reserved for the browser slot. The declaration is not consumed yet,
 * because the browser transport — the `BROWSER` and `LOADER` bindings in the
 * control plane's Worker — is not in place. Whoever adds the transport must
 * add the `browser` slot, contribute this registration with the tool, and
 * give the browser policy delegate ownership of it, or the assembler will
 * refuse the runtime: an external mutation with no owning delegate is never
 * installed.
 */
export const PI_BROWSER_TOOL_EFFECT_REGISTRATIONS = [
  {
    name: "browser",
    effect: "external_mutation",
    callers: ["model"],
    replay: "unsafe",
  },
] as const satisfies readonly ToolEffectRegistration[];

/**
 * The cross-session messaging tool.
 *
 * It changes something outside the model, so it is owned by the cross-session
 * policy delegate and authorized by the owning session on every call.
 */
/**
 * The memory tools.
 *
 * Their names are the shared contract's own, so the Pi surface and the
 * sandbox harnesses expose one canonical set. The reads are reads of the
 * tenant's durable memory, so they are external reads. The write changes
 * something outside the model — a record other sessions will read — so it is
 * an external mutation and needs an owning policy delegate; it is not
 * replay-safe, because an interrupted write that ran again would leave a
 * second record behind.
 *
 * The reads and the write are declared apart, because a deployment that
 * admits the capability read-only declares the reads alone.
 */
export const PI_MEMORY_READ_TOOL_EFFECT_REGISTRATIONS = [
  {
    name: harnessMemoryToolName("pi", "memory_read"),
    effect: "external_read",
    callers: ["model"],
    replay: "safe",
  },
  {
    name: harnessMemoryToolName("pi", "memory_search"),
    effect: "external_read",
    callers: ["model"],
    replay: "safe",
  },
] as const satisfies readonly ToolEffectRegistration[];

export const PI_MEMORY_WRITE_TOOL_EFFECT_REGISTRATIONS = [
  {
    name: harnessMemoryToolName("pi", "memory_write"),
    effect: "external_mutation",
    callers: ["model"],
    replay: "unsafe",
  },
] as const satisfies readonly ToolEffectRegistration[];

export const PI_MEMORY_TOOL_EFFECT_REGISTRATIONS = [
  ...PI_MEMORY_READ_TOOL_EFFECT_REGISTRATIONS,
  ...PI_MEMORY_WRITE_TOOL_EFFECT_REGISTRATIONS,
] as const satisfies readonly ToolEffectRegistration[];

/** Build a lookup while rejecting accidental tool shadowing across extensions. */
export function createToolEffectRegistry(
  ...registrationGroups: readonly (readonly ToolEffectRegistration[])[]
): ReadonlyMap<string, ToolEffectRegistration> {
  const registry = new Map<string, ToolEffectRegistration>();
  for (const registration of registrationGroups.flat()) {
    if (registry.has(registration.name)) {
      throw new Error(`Duplicate Pi tool effect registration: "${registration.name}"`);
    }
    registry.set(registration.name, registration);
  }
  return registry;
}

/** Baseline registry; feature branches should compose this declaration list with their own. */
export const PI_TOOL_EFFECT_REGISTRY = createToolEffectRegistry(PI_TOOL_EFFECT_REGISTRATIONS);
