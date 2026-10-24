import { z } from "zod";
import { assertNoCredentialLikeKeys } from "./credential-shaped";

/**
 * The MCP read path.
 *
 * A personal MCP connection is not available to a session until its owner
 * grants it. The grant names one session and one connection, records the
 * catalog snapshot it was made against, and exposes only the reviewed
 * read-only tools. Mutations are not representable: the connection snapshot
 * only accepts reads.
 */

/** One tool of a server catalog, as a reviewer classifies it. */
export const mcpToolReviewInputSchema = z
  .object({
    toolName: z.string().trim().min(1).max(256),
    title: z.string().max(512).nullish(),
    description: z.string().max(8_192).nullish(),
    inputSchema: z.record(z.string(), z.json()).default({}),
    outputSchema: z.record(z.string(), z.json()).optional(),
    /**
     * The reviewer's classification. A mutation may be recorded so the
     * decision is auditable, but it never reaches the executable catalogue.
     */
    effect: z.enum(["external_read", "external_mutation"]),
  })
  .strict();

export const mcpServerReviewInputSchema = z
  .object({
    serverRevision: z.number().int().positive(),
    tools: z.array(mcpToolReviewInputSchema).max(200),
  })
  .strict();

export type McpServerReviewInput = z.infer<typeof mcpServerReviewInputSchema>;

/** The reviewed tools of one server revision, without any credential. */
export const mcpServerReviewViewSchema = z.object({
  serverId: z.string().min(1),
  serverRevision: z.number().int().positive(),
  reviewedByUserId: z.string().min(1),
  reviewedAt: z.number().int().nonnegative(),
  tools: z.array(
    z.object({
      stableToolId: z.string().min(1),
      toolName: z.string().min(1),
      title: z.string().nullable(),
      description: z.string().nullable(),
      effect: z.enum(["external_read", "external_mutation"]),
      reviewedAt: z.number().int().nonnegative(),
    })
  ),
});

export type McpServerReviewView = z.infer<typeof mcpServerReviewViewSchema>;

/** Grant one connection to one session. */
export const mcpSessionGrantInputSchema = z
  .object({
    /**
     * The connection to attach.
     *
     * The session is named by the route, so the session's own authority is
     * resolved before anything is attached.
     */
    connectionId: z.string().trim().min(1).max(256),
  })
  .strict();

export type McpSessionGrantInput = z.infer<typeof mcpSessionGrantInputSchema>;

/** One session's authorization to use one reviewed MCP connection. */
export const mcpSessionPinSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  connectionId: z.string().min(1),
  serverName: z.string().min(1),
  endpointHost: z.string().min(1),
  /** The reviewed read-only tools this grant exposes. */
  toolNames: z.array(z.string().min(1)),
  createdAt: z.number().int().nonnegative(),
});

export type McpSessionPin = z.infer<typeof mcpSessionPinSchema>;

export const mcpSessionPinListSchema = z.object({
  pins: z.array(mcpSessionPinSchema),
  /** The deployment's shared servers this session may read. */
  shared: z
    .array(
      z.object({
        serverId: z.string().min(1),
        serverName: z.string().min(1),
        endpointHost: z.string().min(1),
        toolNames: z.array(z.string().min(1)),
      })
    )
    .default([]),
});

export type McpSessionPinList = z.infer<typeof mcpSessionPinListSchema>;

/**
 * One reviewed read-only tool call.
 *
 * The request never carries a credential. The owner of the connection is the
 * account whose identity the provider sees, and the SessionDO resolves it.
 */
export const mcpReadRequestSchema = z
  .object({
    /**
     * The personal connection to read through.
     *
     * Exactly one target is named: a personal connection, or a shared
     * server the deployment owns.
     */
    connectionId: z.string().min(1).max(256).optional(),
    /**
     * The shared server to read through.
     *
     * A shared server belongs to the deployment, so the session's own
     * repositories decide whether it exists here at all.
     */
    serverId: z.string().min(1).max(256).optional(),
    toolName: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.json()).default({}),
  })
  .strict()
  .refine((request) => Boolean(request.connectionId) !== Boolean(request.serverId), {
    message: "A read names exactly one target: a personal connection or a shared server",
  });

export type McpReadRequest = z.infer<typeof mcpReadRequestSchema>;

/** The bounded, credential-free result of one reviewed read. */
export const mcpReadResultSchema = z
  .object({
    connectionId: z.string().min(1).optional(),
    serverId: z.string().min(1).optional(),
    toolName: z.string().min(1),
    /**
     * The provider's own result, bounded by the SessionDO before it is
     * stored. It is refused when it carries a credential-shaped key, so a
     * token can never reach the model, the timeline, or the audit.
     */
    content: z.unknown(),
    /** Whether the result was cut to stay inside the bound. */
    truncated: z.boolean(),
  })
  .superRefine((value, context) => {
    assertNoCredentialLikeKeys(value.content, context, ["content"]);
  });

export type McpReadResult = z.infer<typeof mcpReadResultSchema>;

/** The largest MCP result the SessionDO will store and return to the agent. */
export const MAX_MCP_READ_RESULT_BYTES = 64 * 1024;

/** One shared server, as the session resolved it. */
export const mcpSharedServerSchema = z.object({
  serverId: z.string().min(1),
  serverName: z.string().min(1),
  endpointHost: z.string().min(1),
  /** The reviewed read-only tools this server exposes to the session. */
  toolNames: z.array(z.string().min(1)),
});

export type McpSharedServer = z.infer<typeof mcpSharedServerSchema>;

/** The shared servers a session may read. */
export const mcpSharedServerListSchema = z.object({
  shared: z.array(mcpSharedServerSchema).default([]),
});

export type McpSharedServerList = z.infer<typeof mcpSharedServerListSchema>;
