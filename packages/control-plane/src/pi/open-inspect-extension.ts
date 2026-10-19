import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { PI_TOOL_EFFECT_REGISTRY } from "@open-inspect/shared/pi-tool-effects";
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

const repositoryTarget = {
  repository: Type.Optional(
    Type.Integer({ minimum: 0, description: "Session repository position. Defaults to 0." })
  ),
};

function declaredToolEffect(name: string) {
  const effect = PI_TOOL_EFFECT_REGISTRY.get(name);
  if (!effect) throw new Error(`Pi tool has no effect declaration: ${name}`);
  return effect;
}

const repositoryListEffect = declaredToolEffect("repository_list");
const repositoryReadEffect = declaredToolEffect("repository_read");
const subagentEffect = declaredToolEffect("subagent");

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
  const selection = defineExtension({ name: "open-inspect.subagent" });
  return defineExtension({
    name: "open-inspect.subagent",
    sections: [
      section("subagent", () => "Delegate independent analysis to the subagent tool.", {
        tag: false,
      }),
    ],
    tools: [createSubagentTool(selection)],
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
        (selected) => selected.name !== extension.name
      );
      const childId = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: api.taskId },
        });
        await configure(tx, child.id, { extensions: childExtensions });
        return child.id;
      }, context);
      await api.details({ conversationId: childId }, context);
      const child = await api.conversation(childId, context);
      if (!child) throw new Error("Subagent conversation is unavailable");
      const submission = await child.submit(
        {
          type: "input",
          content: task,
          requestId: `subagent:${api.taskId}`,
        },
        context
      );
      const settled = await submission.wait(context);
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
