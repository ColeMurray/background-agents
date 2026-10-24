import { z } from "zod";
import type { JsonValue } from "@earendil-works/chord";
import { readExternalActionMarker, type ExternalActionProviderDefinition } from "./definition";
import { publishedEntries } from "./executor";

const targetSchema = z.record(z.string(), z.json());
const argsSchema = z.record(z.string(), z.json());

/** The public result of one publication: what was created and where. */
const publicationResultSchema = z.object({
  provider: z.string().min(1),
  action: z.string().min(1),
  id: z.string().nullable(),
  url: z.string().nullable(),
});

function requiredString(target: Record<string, JsonValue>, key: string): string {
  const value = target[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The publication target requires ${key}`);
  }
  return value;
}

function requiredNumber(target: Record<string, JsonValue>, key: string): number {
  const value = target[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`The publication target requires ${key}`);
  }
  return value;
}

function requiredText(args: Record<string, JsonValue>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The publication arguments require ${key}`);
  }
  return value;
}

function readId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const id = record.id ?? record.commentId ?? record.noteId ?? record.messageId;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

function readUrl(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const url = record.html_url ?? record.htmlUrl ?? record.url ?? record.permalink;
  return typeof url === "string" ? url : null;
}

function readBodyText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const text = record.body ?? record.text ?? record.message;
  return typeof text === "string" ? text : null;
}

/** The comment body every provider stores, with the reconciliation marker. */
function composeText(args: Record<string, JsonValue>, marker: string): string {
  const text = requiredText(args, "body");
  return `${text}\n\n${marker}`;
}

/**
 * GitHub issue or pull-request comment.
 *
 * The provider is `api.github.com`; the credential is closed over by the
 * executor and never crosses the action boundary.
 */
export const githubCommentDefinition: ExternalActionProviderDefinition = {
  provider: "github",
  action: "comment",
  requestSchema: z.object({ target: targetSchema, arguments: argsSchema }),
  publicResultSchema: publicationResultSchema,
  endpoint: (target) => {
    const owner = requiredString(target, "owner");
    const repo = requiredString(target, "repo");
    const number = requiredNumber(target, "number");
    return {
      method: "POST",
      url: `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
    };
  },
  listPublished: (target) => {
    const owner = requiredString(target, "owner");
    const repo = requiredString(target, "repo");
    const number = requiredNumber(target, "number");
    return {
      method: "GET",
      url: `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
    };
  },
  composeBody: (_target, args, marker) => composeText(args, marker),
  readPublished: (body) => publishedEntries(body),
  readMarker: (body) => readExternalActionMarker(readBodyText(body)),
  readResult: (body) => ({
    provider: "github",
    action: "comment",
    id: readId(body),
    url: readUrl(body),
  }),
};

/** GitLab merge-request or issue note. */
export const gitlabCommentDefinition: ExternalActionProviderDefinition = {
  provider: "gitlab",
  action: "comment",
  requestSchema: z.object({ target: targetSchema, arguments: argsSchema }),
  publicResultSchema: publicationResultSchema,
  endpoint: (target) => {
    const project = requiredString(target, "project");
    const number = requiredNumber(target, "number");
    return {
      method: "POST",
      url: `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/issues/${number}/notes`,
    };
  },
  listPublished: (target) => {
    const project = requiredString(target, "project");
    const number = requiredNumber(target, "number");
    return {
      method: "GET",
      url: `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/issues/${number}/notes?per_page=100`,
    };
  },
  composeBody: (_target, args, marker) => composeText(args, marker),
  readPublished: (body) => publishedEntries(body),
  readMarker: (body) => readExternalActionMarker(readBodyText(body)),
  readResult: (body) => ({
    provider: "gitlab",
    action: "comment",
    id: readId(body),
    url: readUrl(body),
  }),
};

/** Slack reply inside one thread. */
export const slackReplyDefinition: ExternalActionProviderDefinition = {
  provider: "slack",
  action: "reply",
  requestSchema: z.object({ target: targetSchema, arguments: argsSchema }),
  publicResultSchema: publicationResultSchema,
  endpoint: () => ({ method: "POST", url: "https://slack.com/api/chat.postMessage" }),
  listPublished: (target) => {
    const channel = requiredString(target, "channel");
    const thread = requiredString(target, "thread");
    return {
      method: "GET",
      url: `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(thread)}&limit=100`,
    };
  },
  composeBody: (target, args, marker) =>
    JSON.stringify({
      channel: requiredString(target, "channel"),
      thread_ts: requiredString(target, "thread"),
      text: composeText(args, marker),
    }),
  readPublished: (body) => publishedEntries(body),
  readMarker: (body) => readExternalActionMarker(readBodyText(body)),
  readResult: (body) => ({
    provider: "slack",
    action: "reply",
    id: readId(body),
    url: readUrl(body),
  }),
};

/** Linear issue comment. */
export const linearCommentDefinition: ExternalActionProviderDefinition = {
  provider: "linear",
  action: "comment",
  requestSchema: z.object({ target: targetSchema, arguments: argsSchema }),
  publicResultSchema: publicationResultSchema,
  endpoint: () => ({ method: "POST", url: "https://api.linear.app/graphql" }),
  listPublished: (target) => {
    const issueId = requiredString(target, "issueId");
    return {
      method: "POST",
      url: "https://api.linear.app/graphql",
      body: JSON.stringify({
        query: "query($id: String!) { issue(id: $id) { comments { nodes { id url body } } } }",
        variables: { id: issueId },
      }),
    };
  },
  composeBody: (target, args, marker) =>
    JSON.stringify({
      query:
        "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url body } } }",
      variables: {
        input: { issueId: requiredString(target, "issueId"), body: composeText(args, marker) },
      },
    }),
  readPublished: (body) => {
    const nodes = linearCommentNodes(body);
    return nodes.length > 0 ? nodes : publishedEntries(body);
  },
  readMarker: (body) => {
    if (typeof body !== "object" || body === null) return null;
    const record = body as Record<string, unknown>;
    const data = record.data;
    if (typeof data !== "object" || data === null) {
      return readExternalActionMarker(readBodyText(body));
    }
    const commentCreate = (data as Record<string, unknown>).commentCreate;
    if (typeof commentCreate !== "object" || commentCreate === null) return null;
    const comment = (commentCreate as Record<string, unknown>).comment;
    return readExternalActionMarker(readBodyText(comment));
  },
  readResult: (body) => {
    if (typeof body !== "object" || body === null) {
      return { provider: "linear", action: "comment", id: null, url: null };
    }
    const record = body as Record<string, unknown>;
    const data = record.data;
    const commentCreate =
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>).commentCreate
        : undefined;
    const comment =
      typeof commentCreate === "object" && commentCreate !== null
        ? (commentCreate as Record<string, unknown>).comment
        : undefined;
    return {
      provider: "linear",
      action: "comment",
      id: readId(comment ?? body),
      url: readUrl(comment ?? body),
    };
  },
};

/** The comments Linear already keeps on one issue. */
function linearCommentNodes(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return [];
  const issue = (data as Record<string, unknown>).issue;
  if (typeof issue !== "object" || issue === null) return [];
  const comments = (issue as Record<string, unknown>).comments;
  if (typeof comments !== "object" || comments === null) return [];
  const nodes = (comments as Record<string, unknown>).nodes;
  return Array.isArray(nodes) ? nodes : [];
}

export const EXTERNAL_ACTION_PROVIDER_DEFINITIONS: readonly ExternalActionProviderDefinition[] = [
  githubCommentDefinition,
  gitlabCommentDefinition,
  slackReplyDefinition,
  linearCommentDefinition,
];
