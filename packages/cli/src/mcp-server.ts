import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  externalCreateSessionRequestSchema,
  externalEventPageSchema,
  externalEventFeedQuerySchema,
  externalFollowUpRequestSchema,
  externalFollowUpResponseSchema,
  externalSessionListQuerySchema,
  externalSessionListResponseSchema,
  externalSessionSchema,
  externalSessionWaitResponseSchema,
  externalStopSessionResponseSchema,
} from "@open-inspect/shared/types/external-session-api";
import {
  externalChildPromptRequestSchema,
  externalEnvironmentListResponseSchema,
  externalEnvironmentResponseSchema,
  externalKeysetListQuerySchema,
  externalListQuerySchema,
  externalMessageListResponseSchema,
  externalArtifactListResponseSchema,
  externalArtifactContentResponseSchema,
  externalDiffStateResponseSchema,
  externalDiffContentResponseSchema,
  externalModelListResponseSchema,
  externalProviderAccountListResponseSchema,
  externalPullRequestListResponseSchema,
  externalPullRequestSchema,
  externalRepositoryListResponseSchema,
  externalSkillListResponseSchema,
  externalChildSessionListResponseSchema,
  externalChildSessionSchema,
} from "@open-inspect/shared/types/external-resources-api";
import { classifyError, CliError, publicErrorCode, withErrorContext } from "./errors.js";
import type { Operations } from "./operations.js";
import { validateAttachmentBytes } from "./attachments.js";

const sessionId = z.string().min(1).describe("Open Inspect session ID");
const MAX_WAIT_TIMEOUT_MS = 300_000;
export const MAX_MCP_RESULT_BYTES = 1024 * 1024;
const polling = {
  pollIntervalMs: z.number().int().min(100).max(30_000).optional(),
  timeoutMs: z.number().int().nonnegative().max(MAX_WAIT_TIMEOUT_MS).optional(),
};
const createToolOutputSchema = z
  .strictObject({
    sessionId: z.string().min(1),
    status: z.enum(["created", "queued"]),
    messageId: z.string().min(1).optional(),
    url: z.string().optional(),
  })
  .superRefine((result, ctx) => {
    if ((result.status === "queued") !== Boolean(result.messageId)) {
      ctx.addIssue({
        code: "custom",
        message: "messageId must be present exactly when status is queued",
        path: ["messageId"],
      });
    }
  });
const artifactToolOutputSchema = coherentOutputSchema(
  {
    ...externalArtifactListResponseSchema.shape,
    ...externalArtifactContentResponseSchema.shape,
  },
  [externalArtifactListResponseSchema, externalArtifactContentResponseSchema]
);
const diffToolOutputSchema = coherentOutputSchema(
  {
    ...externalDiffStateResponseSchema.shape,
    ...externalDiffContentResponseSchema.shape,
  },
  [externalDiffStateResponseSchema, externalDiffContentResponseSchema]
);
const pullRequestToolOutputSchema = coherentOutputSchema(
  {
    ...externalPullRequestListResponseSchema.shape,
    ...externalPullRequestSchema.shape,
  },
  [externalPullRequestListResponseSchema, externalPullRequestSchema]
);
const childToolOutputSchema = coherentOutputSchema(
  {
    ...externalChildSessionListResponseSchema.shape,
    ...externalChildSessionSchema.shape,
  },
  [externalChildSessionListResponseSchema, externalChildSessionSchema]
);

/** Creates the full V1 MCP surface over the shared operations layer. */
export function createMcpServer(operations: Operations): McpServer {
  const server = new McpServer({ name: "open-inspect", version: "0.1.0" });

  server.registerTool(
    "session_create",
    {
      description: "Create an asynchronous session. Use session_prompt for later follow-ups.",
      inputSchema: {
        ...externalCreateSessionRequestSchema.shape,
        attachmentPaths: z.array(z.string()).max(6).optional(),
      },
      outputSchema: createToolOutputSchema,
    },
    async ({ attachmentPaths, ...input }) =>
      runTool(async () => {
        const attachmentCount =
          (attachmentPaths?.length ?? 0) + (input.initialAttachments?.length ?? 0);
        if (attachmentCount > 6)
          throw new CliError("validation", "A prompt may include at most 6 attachments");
        const parsed = externalCreateSessionRequestSchema.parse({
          ...input,
          ...(attachmentPaths?.length
            ? {
                initialPrompt: undefined,
                initialAttachments: undefined,
                initialAttachmentCount: attachmentCount,
              }
            : {}),
        });
        const localFiles = await resolveMcpAttachments(server, attachmentPaths ?? []);
        const created = await operations.createSession(parsed);
        if (!attachmentPaths?.length) return created;
        try {
          const uploadedAttachments = await uploadMcpAttachments(
            operations,
            created.sessionId,
            localFiles,
            input.idempotencyKey
          );
          const attachments = [...(input.initialAttachments ?? []), ...uploadedAttachments];
          if (!input.initialPrompt?.trim() && attachments.length === 0) return created;
          const prompted = await operations.promptSession(created.sessionId, {
            content: input.initialPrompt,
            attachments,
            clientRequestId: `external-create:${input.idempotencyKey}`,
            model: input.model,
            reasoningEffort: input.reasoningEffort,
          });
          return { sessionId: created.sessionId, ...prompted };
        } catch (cause) {
          throw withErrorContext(cause, {
            sessionId: created.sessionId,
            failedStage: "attachment_or_prompt",
            idempotencyKey: input.idempotencyKey,
          });
        }
      })
  );
  registerDiscoveryTools(server, operations);
  server.registerTool(
    "session_list",
    {
      description: "List sessions visible to the authenticated workspace user",
      inputSchema: { ...externalSessionListQuerySchema.shape },
      outputSchema: externalSessionListResponseSchema,
    },
    async (query) =>
      runTool(() => operations.listSessions(externalSessionListQuerySchema.parse(query)))
  );
  server.registerTool(
    "session_get",
    {
      description: "Get a canonical session summary and related resource identifiers",
      inputSchema: { sessionId },
      outputSchema: externalSessionSchema,
    },
    async ({ sessionId }) => runTool(() => operations.getSession(sessionId))
  );
  server.registerTool(
    "session_prompt",
    {
      description: "Send an idempotent follow-up; use session_create only for new sessions",
      inputSchema: {
        sessionId,
        ...externalFollowUpRequestSchema.shape,
        attachmentPaths: z.array(z.string()).max(6).optional(),
      },
      outputSchema: externalFollowUpResponseSchema,
    },
    async ({ sessionId, attachmentPaths, ...input }) =>
      runTool(async () => {
        if ((attachmentPaths?.length ?? 0) + (input.attachments?.length ?? 0) > 6) {
          throw new CliError("validation", "A prompt may include at most 6 attachments");
        }
        const files = await resolveMcpAttachments(server, attachmentPaths ?? []);
        const local = files.length
          ? await uploadMcpAttachments(operations, sessionId, files, input.clientRequestId)
          : [];
        return operations.promptSession(
          sessionId,
          externalFollowUpRequestSchema.parse({
            ...input,
            attachments: [...(input.attachments ?? []), ...local],
          })
        );
      })
  );
  server.registerTool(
    "session_stop",
    {
      description: "Stop a session",
      inputSchema: { sessionId },
      outputSchema: externalStopSessionResponseSchema,
    },
    async ({ sessionId }) => runTool(() => operations.stopSession(sessionId))
  );
  server.registerTool(
    "session_events",
    {
      description: "Read a bounded trajectory snapshot or changes after a checkpoint",
      inputSchema: { sessionId, ...externalEventFeedQuerySchema.shape },
      outputSchema: externalEventPageSchema,
    },
    async ({ sessionId, ...query }) =>
      runTool(() => operations.events(sessionId, externalEventFeedQuerySchema.parse(query)))
  );
  server.registerTool(
    "session_wait",
    {
      description: "Wait for terminal session state; use session_events for progress",
      inputSchema: { sessionId, ...polling },
      outputSchema: externalSessionWaitResponseSchema,
    },
    async ({ sessionId, ...options }) => runTool(() => operations.wait(sessionId, options))
  );
  registerSessionReadTools(server, operations);

  return server;
}

function registerDiscoveryTools(server: McpServer, operations: Operations): void {
  const page = { ...externalListQuerySchema.shape };
  server.registerTool(
    "repository_list",
    {
      description: "Discover usable repositories",
      inputSchema: page,
      outputSchema: externalRepositoryListResponseSchema,
    },
    (input) => runTool(() => operations.listRepositories(externalListQuerySchema.parse(input)))
  );
  server.registerTool(
    "environment_list",
    {
      description: "Discover saved environments",
      inputSchema: page,
      outputSchema: externalEnvironmentListResponseSchema,
    },
    (input) => runTool(() => operations.listEnvironments(externalListQuerySchema.parse(input)))
  );
  server.registerTool(
    "environment_get",
    {
      description: "Read one saved environment",
      inputSchema: { environmentId: z.string().min(1) },
      outputSchema: externalEnvironmentResponseSchema,
    },
    ({ environmentId }) => runTool(() => operations.getEnvironment(environmentId))
  );
  server.registerTool(
    "model_list",
    {
      description: "List enabled models and reasoning options",
      outputSchema: externalModelListResponseSchema,
    },
    () => runTool(() => operations.listModels())
  );
  server.registerTool(
    "skill_list",
    {
      description: "Discover managed skills and owned profiles",
      inputSchema: page,
      outputSchema: externalSkillListResponseSchema,
    },
    (input) => runTool(() => operations.listSkills(externalListQuerySchema.parse(input)))
  );
  server.registerTool(
    "provider_account_list",
    {
      description: "Discover selectable non-secret provider accounts",
      inputSchema: page,
      outputSchema: externalProviderAccountListResponseSchema,
    },
    (input) => runTool(() => operations.listProviderAccounts(externalListQuerySchema.parse(input)))
  );
}

function registerSessionReadTools(server: McpServer, operations: Operations): void {
  server.registerTool(
    "session_messages",
    {
      description: "Read persisted conversation messages",
      inputSchema: {
        sessionId,
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
      outputSchema: externalMessageListResponseSchema,
    },
    ({ sessionId, ...options }) => runTool(() => operations.messages(sessionId, options))
  );
  server.registerTool(
    "session_artifacts",
    {
      description: "List bounded typed artifacts or retrieve screenshot/video content by ID",
      inputSchema: {
        sessionId,
        artifactId: z.string().min(1).optional(),
        contentOffset: z.number().int().nonnegative().optional(),
        contentLimit: z
          .number()
          .int()
          .min(1)
          .max(512 * 1024)
          .optional(),
        ...externalKeysetListQuerySchema.shape,
      },
      outputSchema: artifactToolOutputSchema,
    },
    ({ sessionId, artifactId, contentOffset, contentLimit, ...page }) =>
      runTool(() =>
        artifactId
          ? operations.artifactContent(sessionId, artifactId, {
              offset: contentOffset,
              limit: contentLimit,
            })
          : operations.artifacts(sessionId, externalKeysetListQuerySchema.parse(page))
      )
  );
  server.registerTool(
    "session_diff",
    {
      description: "Read bounded diff state or one revision-pinned file patch",
      inputSchema: {
        sessionId,
        revisionId: z.string().optional(),
        fileId: z.string().optional(),
        contentOffset: z.number().int().nonnegative().optional(),
        contentLimit: z
          .number()
          .int()
          .min(1)
          .max(512 * 1024)
          .optional(),
        ...externalListQuerySchema.shape,
      },
      outputSchema: diffToolOutputSchema,
    },
    ({ sessionId, revisionId, fileId, contentOffset, contentLimit, ...page }) =>
      runTool(() => {
        if (Boolean(revisionId) !== Boolean(fileId)) {
          throw new CliError("validation", "revisionId and fileId must be provided together");
        }
        return revisionId && fileId
          ? operations.diffFile(sessionId, revisionId, fileId, {
              offset: contentOffset,
              limit: contentLimit,
            })
          : operations.diff(sessionId, externalListQuerySchema.parse(page));
      })
  );
  server.registerTool(
    "session_pull_requests",
    {
      description: "List bounded pull requests or retrieve one by its session-scoped ID",
      inputSchema: {
        sessionId,
        pullRequestId: z.string().min(1).optional(),
        ...externalListQuerySchema.shape,
      },
      outputSchema: pullRequestToolOutputSchema,
    },
    ({ sessionId, pullRequestId, ...page }) =>
      runTool(() =>
        pullRequestId
          ? operations.pullRequest(sessionId, pullRequestId)
          : operations.pullRequests(sessionId, externalListQuerySchema.parse(page))
      )
  );
  server.registerTool(
    "session_children",
    {
      description: "List bounded direct children or inspect one child",
      inputSchema: { sessionId, childId: z.string().optional(), ...externalListQuerySchema.shape },
      outputSchema: childToolOutputSchema,
    },
    ({ sessionId, childId, ...page }) =>
      runTool(() =>
        childId
          ? operations.child(sessionId, childId)
          : operations.children(sessionId, externalListQuerySchema.parse(page))
      )
  );
  server.registerTool(
    "session_child_prompt",
    {
      description: "Send a canonical-user follow-up to an existing direct child",
      inputSchema: {
        sessionId,
        childId: z.string().min(1),
        ...externalChildPromptRequestSchema.shape,
      },
      outputSchema: externalFollowUpResponseSchema,
    },
    ({ sessionId, childId, ...input }) =>
      runTool(() =>
        operations.promptChild(sessionId, childId, externalChildPromptRequestSchema.parse(input))
      )
  );
}

async function resolveMcpAttachments(
  server: McpServer,
  paths: string[]
): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  if (paths.length === 0) return [];
  if (!server.server.getClientCapabilities()?.roots) {
    throw new CliError("validation", "MCP client did not negotiate filesystem roots");
  }
  const roots = (await server.server.listRoots()).roots
    .filter(({ uri }) => uri.startsWith("file:"))
    .map(({ uri }) => fileURLToPath(uri));
  if (roots.length === 0) throw new CliError("validation", "No MCP filesystem roots are available");
  const realRoots = await Promise.all(roots.map((root) => realpath(root)));
  const files = [];
  for (const path of paths) {
    const resolved = await realpath(path);
    if (
      !realRoots.some((root) => {
        const child = relative(root, resolved);
        return child === "" || (!child.startsWith("..") && !isAbsolute(child));
      })
    ) {
      throw new CliError("validation", `Attachment is outside negotiated roots: ${basename(path)}`);
    }
    const name = basename(resolved);
    const bytes = await readFile(resolved);
    validateAttachmentBytes(bytes, name);
    files.push({ name, bytes });
  }
  return files;
}

async function uploadMcpAttachments(
  operations: Operations,
  sessionIdValue: string,
  files: Array<{ name: string; bytes: Uint8Array }>,
  idempotencyKey: string
): Promise<Array<{ attachmentId: string; name: string }>> {
  const uploaded = [];
  for (const [index, { name, bytes }] of files.entries()) {
    const result = await operations.uploadAttachment(
      sessionIdValue,
      new Blob([bytes]),
      name,
      `${idempotencyKey}:${index}`
    );
    uploaded.push({ attachmentId: result.attachmentId, name });
  }
  return uploaded;
}

/** Starts stdio transport without writing non-protocol data to stdout. */
export async function serveMcp(operations: Operations): Promise<void> {
  await createMcpServer(operations).connect(new StdioServerTransport());
}

export function toolResult(value: unknown) {
  const result = { content: [], structuredContent: asRecord(value) };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_MCP_RESULT_BYTES)
    throw new CliError("service", `MCP result exceeded ${MAX_MCP_RESULT_BYTES} bytes`);
  return result;
}

async function runTool(action: () => Promise<unknown>) {
  try {
    return toolResult(await action());
  } catch (cause) {
    const error = classifyError(cause);
    return {
      isError: true,
      content: [{ type: "text" as const, text: error.message }],
      structuredContent: {
        error: {
          code: publicErrorCode(error),
          message: error.message,
          ...(error.status ? { status: error.status } : {}),
          ...(error.context ? { context: error.context } : {}),
        },
      },
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}

function coherentOutputSchema(
  shape: z.ZodRawShape,
  variants: readonly z.ZodType[]
): z.ZodObject<z.ZodRawShape> {
  return z
    .looseObject(shape)
    .partial()
    .superRefine((result, ctx) => {
      if (variants.filter((variant) => variant.safeParse(result).success).length !== 1) {
        ctx.addIssue({ code: "custom", message: "Output must match exactly one operation mode" });
      }
    });
}
