import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { PI_TOOL_EFFECT_REGISTRY } from "@open-inspect/shared/pi-tool-effects";
import { sha256Hex } from "@open-inspect/shared/service-auth";
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
  section,
  type EntryId,
  type Extension,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { PiRuntimeControl } from "../pi/runtime-contract";

interface PiRepositoryDescriptor {
  repoOwner: string;
  repoName: string;
  position: number;
  baseBranch: string | null;
}

interface OpenInspectExtensionOptions {
  repositories: readonly PiRepositoryDescriptor[];
  invokeRepository(
    tool: "repository_list" | "repository_read",
    args: Record<string, JsonValue | undefined>,
    signal?: AbortSignal
  ): Promise<JsonValue>;
}

type WithoutSession<T> = T extends unknown ? Omit<T, "sessionId"> : never;
export type PiAgentControlRequest = WithoutSession<PiRuntimeControl>;

interface AgentMessagingExtensionOptions {
  invoke(
    control: PiAgentControlRequest,
    callerConversationId: number,
    signal?: AbortSignal
  ): Promise<JsonValue>;
}

const repositoryTarget = {
  repository: Type.Optional(
    Type.Integer({ minimum: 0, description: "Session repository position. Defaults to 0." })
  ),
};

function declaredToolEffect(name: string) {
  const effect = PI_TOOL_EFFECT_REGISTRY.get(name);
  if (!effect) throw new Error(`Tool has no effect declaration: ${name}`);
  return effect;
}

const repositoryListEffect = declaredToolEffect("repository_list");
const repositoryReadEffect = declaredToolEffect("repository_read");
const subagentEffect = declaredToolEffect("subagent");
const MAX_ACTIVE_SUBAGENTS = 4;
const MAX_CONVERSATIONS = 32;
const SUBAGENT_TIMEOUT_MS = 10 * 60 * 1_000;
export const AGENT_MESSAGING_EXTENSION_NAME = "open-inspect.agent-messaging";
export const SUBAGENT_EXTENSION_NAME = "open-inspect.subagent";

const repositoryList = defineTool({
  name: "repository_list",
  description: "List files from a repository attached to this session at an immutable commit.",
  parameters: Type.Object({
    ...repositoryTarget,
    path: Type.Optional(
      Type.String({ description: "Repository-relative directory to narrow the recursive listing." })
    ),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Entry offset. Default 0." })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 500, description: "Entries to return. Default 500." })
    ),
  }),
  structuredOutputSchema: Type.Any(),
  replay: repositoryListEffect.replay,
  callers: repositoryListEffect.callers,
  execute: async () => ({ isError: true, output: [{ type: "text", text: "Tool not bound" }] }),
});

const repositoryRead = defineTool({
  name: "repository_read",
  description: "Read a UTF-8 text file from a repository attached to this session.",
  parameters: Type.Object({
    ...repositoryTarget,
    path: Type.String({ description: "Repository-relative file path." }),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: "Character offset. Default 0." })
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 50_000, description: "Characters to return." })
    ),
  }),
  structuredOutputSchema: Type.Any(),
  replay: repositoryReadEffect.replay,
  callers: repositoryReadEffect.callers,
  execute: async () => ({ isError: true, output: [{ type: "text", text: "Tool not bound" }] }),
});

/** Open-Inspect control-plane tools and durable Pi-native subagents. */
export function createOpenInspectExtension(options: OpenInspectExtensionOptions) {
  const repositoryTools =
    options.repositories.length === 0
      ? []
      : [
          bindRepositoryTool(
            "repository_list",
            repositoryList,
            options.repositories,
            options.invokeRepository
          ),
          bindRepositoryTool(
            "repository_read",
            repositoryRead,
            options.repositories,
            options.invokeRepository
          ),
        ];
  return defineExtension({
    name: "open-inspect",
    sections: [
      section(
        "open_inspect",
        () =>
          [
            "You are running in Open-Inspect on Pi Durable. Use the installed tools for durable, authorized work.",
            options.repositories.length > 0
              ? "Repository tools read the session's pinned repositories without creating a sandbox."
              : "This session has no attached repository.",
          ].join(" "),
        { tag: false }
      ),
    ],
    tools: repositoryTools,
  });
}

/** Separate extension so a child can lose only recursive delegation and retain its other tools. */
export function createSubagentExtension(): Extension {
  const selection = defineExtension({ name: SUBAGENT_EXTENSION_NAME });
  return defineExtension({
    name: SUBAGENT_EXTENSION_NAME,
    sections: [
      section("subagent", () => "Delegate independent analysis to the subagent tool.", {
        tag: false,
      }),
    ],
    tools: [createSubagentTool(selection)],
  });
}

/** Root-only controls for durable same-session conversations. */
export function createAgentMessagingExtension(options: AgentMessagingExtensionOptions): Extension {
  const controlTool = <T extends ReturnType<typeof Type.Object>>(
    name: string,
    description: string,
    parameters: T,
    action: (args: Record<string, unknown>, requestId: string) => PiAgentControlRequest
  ) => {
    const effect = declaredToolEffect(name);
    return defineTool({
      name,
      description,
      parameters,
      structuredOutputSchema: Type.Any(),
      replay: effect.replay,
      callers: effect.callers,
      execute: async (args, api, context) => {
        const requestId = await agentControlRequestId(api.taskId, api.callId, name);
        const result = await options.invoke(
          action(args as Record<string, unknown>, requestId),
          api.conversationId,
          context.abortSignal
        );
        return {
          output: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredOutput: result,
        };
      },
    });
  };
  const conversation = {
    conversationId: Type.Integer({ minimum: 1, description: "Target Pi conversation ID." }),
  };
  const message = {
    ...conversation,
    content: Type.String({ minLength: 1, maxLength: 20_000, description: "Message to send." }),
  };
  return defineExtension({
    name: AGENT_MESSAGING_EXTENSION_NAME,
    sections: [
      section(
        "agent_messaging",
        () =>
          "Use agent controls only for same-session child conversations. Ordinary user turns remain queued separately.",
        { tag: false }
      ),
    ],
    tools: [
      controlTool(
        "list_agents",
        "List bounded same-session agents, status, tasks, and usage.",
        Type.Object({}),
        (_args, requestId) => ({ action: "inspect_agents", requestId })
      ),
      controlTool(
        "send_agent_message",
        "Send a new message to an idle same-session agent.",
        Type.Object(message),
        (args, requestId) => ({
          action: "send",
          requestId,
          conversationId: Number(args.conversationId),
          content: String(args.content),
        })
      ),
      controlTool(
        "get_last_message",
        "Read only the latest visible assistant text from a same-session agent.",
        Type.Object(conversation),
        (args, requestId) => ({
          action: "get_last_message",
          requestId,
          conversationId: Number(args.conversationId),
        })
      ),
      controlTool(
        "follow_up_agent",
        "Queue an explicit immediate follow-up for an active same-session agent.",
        Type.Object(message),
        (args, requestId) => ({
          action: "follow_up",
          requestId,
          conversationId: Number(args.conversationId),
          content: String(args.content),
        })
      ),
      controlTool(
        "cancel_agent",
        "Cancel one exact active same-session agent task.",
        Type.Object({ taskId: Type.Integer({ minimum: 1, description: "Exact Pi task ID." }) }),
        (args, requestId) => ({
          action: "cancel_agent",
          requestId,
          taskId: Number(args.taskId),
        })
      ),
      controlTool(
        "inspect_agents",
        "Inspect bounded same-session agent state without prompts, tool arguments, or credentials.",
        Type.Object({}),
        (_args, requestId) => ({ action: "inspect_agents", requestId })
      ),
    ],
  });
}

function bindRepositoryTool(
  toolName: "repository_list" | "repository_read",
  tool: typeof repositoryList | typeof repositoryRead,
  repositories: readonly PiRepositoryDescriptor[],
  invoke: OpenInspectExtensionOptions["invokeRepository"]
) {
  return {
    ...tool,
    execute: async (
      args: Record<string, JsonValue | undefined>,
      _api: ToolExecutionApi,
      context: Context
    ) => {
      const position = typeof args.repository === "number" ? args.repository : 0;
      const repository = repositories.find((candidate) => candidate.position === position);
      if (!repository) throw new Error(`Repository index ${position} is not part of this session`);
      const result = await invoke(toolName, args, context.abortSignal);
      return {
        output: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredOutput: result,
      };
    },
  };
}

function createSubagentTool(extension: Extension) {
  return defineTool({
    name: "subagent",
    description: "Delegate one self-contained analysis task to a durable foreground subagent.",
    parameters: Type.Object({
      task: Type.String({
        minLength: 1,
        maxLength: 20_000,
        description: "The task for the subagent.",
      }),
    }),
    replay: subagentEffect.replay,
    callers: subagentEffect.callers,
    execute: async ({ task }, api, context) => {
      // Resolve outside the commit: a transaction must never wait on registry or
      // environment work. Write the exact parent selection minus recursive
      // delegation; `{ remove }` would incorrectly restart from host defaults
      // when the parent stores an explicit extension list.
      const childExtensions = (await api.agent(context)).extensions.filter(
        (selected) =>
          selected.name !== extension.name && selected.name !== AGENT_MESSAGING_EXTENSION_NAME
      );
      const childId = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        const conversations = (await tx.scanConversations({}, MAX_CONVERSATIONS + 1)).items;
        if (conversations.length >= MAX_CONVERSATIONS) {
          throw new Error("Pi conversation limit reached");
        }
        let activeSubagents = 0;
        for (const conversation of conversations) {
          if (!conversation.owner) continue;
          const owner = await tx.task(conversation.owner.taskId);
          if (owner && owner.state.status !== "terminal") activeSubagents += 1;
        }
        if (activeSubagents >= MAX_ACTIVE_SUBAGENTS) {
          throw new Error("Pi active subagent limit reached");
        }
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: api.taskId },
        });
        await configure(tx, child.id, { extensions: childExtensions });
        return child.id;
      }, context);
      await api.details({ conversationId: childId }, context);
      const child = await api.conversation(childId, context);
      if (!child) throw new Error("Subagent conversation is unavailable");
      const timeoutSignal = AbortSignal.timeout(SUBAGENT_TIMEOUT_MS);
      const runContext = withAbortSignal(timeoutSignal, context);
      const submission = await child.submit(
        {
          type: "input",
          content: task,
          requestId: `subagent:${api.taskId}`,
        },
        runContext
      );
      const settled = await submission.wait(runContext).catch(async (error: unknown) => {
        await submission.abort(BACKGROUND_CONTEXT).catch(() => "settled" as const);
        await child.abort(BACKGROUND_CONTEXT, { background: true }).catch(() => undefined);
        if (timeoutSignal.aborted && !context.abortSignal?.aborted) {
          throw new Error("Subagent timed out", { cause: error });
        }
        throw error;
      });
      if (settled.status !== "done" || settled.type !== "input") {
        throw new Error(`Subagent failed: ${settled.status}`);
      }
      const answer = await answerText(api, settled.answer, context);
      return {
        output: [{ type: "text", text: answer }],
        details: { conversationId: childId },
      };
    },
  });
}

async function agentControlRequestId(
  taskId: ToolExecutionApi["taskId"],
  callId: string,
  action: string
): Promise<string> {
  return `agent:${await sha256Hex(`${String(taskId)}:${callId}:${action}`)}`;
}

async function answerText(
  api: ToolExecutionApi,
  answerId: EntryId,
  context: Context
): Promise<string> {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answerId), context);
  const message = entry?.model?.[0];
  if (!message || message.role !== "assistant") return "";
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
