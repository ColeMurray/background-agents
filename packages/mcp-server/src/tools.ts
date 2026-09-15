/**
 * The tool surface.
 *
 * Reads are one GET each against a route whose policy already accepts an
 * access-token principal. The writes — skill import and re-import, automation
 * create, and manual automation trigger — reach only the routes that opted a
 * token into writing, each of them additive; the control plane refuses this
 * credential every other mutating method, so there is no tool here that
 * deletes an automation, rewrites one, or pauses its schedule.
 */

import { harnessIdSchema } from "@open-inspect/shared/harnesses";
import { automationTriggerTypeSchema, triggerConfigSchema } from "@open-inspect/shared/triggers";
import {
  MAX_AUTOMATION_INSTRUCTIONS_LENGTH,
  MAX_AUTOMATION_REPOSITORIES,
  sentryClientSecretSchema,
} from "@open-inspect/shared/types/automations";
import { SKILL_LIST_PAGE_SIZE } from "@open-inspect/shared/types/skills";
import { z } from "zod";
import type { ControlPlaneClient } from "./client";

/**
 * Page caps, matching what the control-plane handlers themselves enforce.
 * Asking past a server cap is silently clamped, which reads as a short page
 * and invites the model to conclude there is nothing more.
 */
const MAX_EVENT_LIMIT = 200;
const DEFAULT_EVENT_LIMIT = 100;

const MAX_MESSAGE_LIMIT = 100;

const MAX_SESSION_LIMIT = 100;
const DEFAULT_SESSION_LIMIT = 20;

/** Every paged tool takes the same continuation argument. */
const cursor = z
  .string()
  .optional()
  .describe("Continuation cursor from a previous page of this same call");

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** Drives the MCP `readOnlyHint`, which is how a client decides what to prompt for. */
  readOnly: boolean;
  /**
   * Drives the MCP `destructiveHint`, which means additive-only when false.
   * Set it on a write that replaces something a later reader will act on, even
   * where the previous value remains recoverable. Meaningless on a read tool.
   */
  destructive?: true;
  inputSchema: z.ZodRawShape;
  run(client: ControlPlaneClient, args: Record<string, unknown>): Promise<unknown>;
}

const sessionId = z.string().min(1).describe("Session id, as returned by list_sessions");

const automationId = z
  .string()
  .min(1)
  .describe("Automation id, as returned by create_automation or shown in the web UI");

/**
 * The preview fields a confirmation needs, read leniently.
 *
 * `z.object` rather than the control plane's own `strictObject` schema: this
 * server is built on a laptop and talks to a deployment that may be a version
 * ahead, and an unrecognized field is no reason to fail an import.
 */
const importPreviewSchema = z.object({
  name: z.string(),
  description: z.string(),
  nameAvailable: z.boolean(),
  revisionSha256: z.string(),
  totalBytes: z.number(),
  source: z.object({
    provider: z.string(),
    repoOwner: z.string(),
    repoName: z.string(),
    resolvedRef: z.string(),
    commitSha: z.string(),
    subdirectory: z.string().nullable(),
    sourceSha256: z.string(),
  }),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })).default([]),
  files: z.array(z.object({ path: z.string() })).default([]),
});

type ImportPreview = z.infer<typeof importPreviewSchema>;

/** The identity of a stored skill, without the revision content. */
const storedSkillSchema = z.object({
  skill: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    currentRevisionId: z.string(),
    revisionNumber: z.number(),
    /**
     * Recorded provenance, passed through as the control plane sent it rather
     * than narrowed to a shape this build knows — every field of it is a fact
     * about what is stored, and dropping one would report less than is known.
     */
    source: z.unknown().optional(),
  }),
});

function parsePreview(value: unknown): ImportPreview {
  const parsed = importPreviewSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Control plane returned an unrecognized import preview: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

function parseStoredSkill(value: unknown): z.infer<typeof storedSkillSchema>["skill"] {
  const parsed = storedSkillSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Control plane returned an unrecognized skill: ${parsed.error.message}`);
  }
  return parsed.data.skill;
}

/**
 * Pin a confirmation to the bytes the preview showed.
 *
 * The control plane re-reads the source when it applies an import and refuses
 * to store anything that no longer matches these digests. Previewing and
 * confirming in one tool call leaves only a race to catch, and a moved source
 * surfaces as a 409 rather than as an unreviewed import.
 */
function confirmation(preview: ImportPreview): Record<string, string> {
  return {
    expectedCommitSha: preview.source.commitSha,
    expectedSourceSha256: preview.source.sourceSha256,
    expectedRevisionSha256: preview.revisionSha256,
  };
}

/** What both write tools report back, without the skill body or file contents. */
function importReport(
  skill: z.infer<typeof storedSkillSchema>["skill"],
  preview: ImportPreview
): Record<string, unknown> {
  const { source, ...identity } = skill;
  return {
    skill: identity,
    // Provenance as stored, never as previewed. A re-import whose content
    // digest is unchanged keeps the revision it had, and the provenance that
    // came with it: reporting the previewed commit there would claim the skill
    // had moved to a commit it was never recorded at.
    source: source ?? preview.source,
    files: preview.files.map((file) => file.path),
    totalBytes: preview.totalBytes,
    warnings: preview.warnings,
  };
}

/** One entry of create_automation's repository list, before camel-casing. */
interface AutomationRepositoryArg {
  repo_owner: string;
  repo_name: string;
  base_branch?: string;
}

const repoOwner = z
  .string()
  .min(1)
  .describe(
    "Repository owner. May contain `/` where the provider nests namespaces, as GitLab subgroups do."
  );
const repoName = z.string().min(1).describe("Repository name, a single path segment");
const importRef = z
  .string()
  .min(1)
  .optional()
  .describe("Branch, tag, or commit to read. Defaults to the repository's default branch.");

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_sessions",
    title: "List sessions",
    readOnly: true,
    description:
      "List Open-Inspect sessions, newest first. Use to find a session id before reading its " +
      "events or diff. Filter by status to narrow to active or failed work.",
    inputSchema: {
      status: z
        .enum(["created", "active", "completed", "failed", "archived", "cancelled"])
        .optional()
        .describe("Only sessions in this status. In-flight work is `active`, not `running`."),
      limit: z.number().int().min(1).max(MAX_SESSION_LIMIT).optional(),
      offset: z.number().int().min(0).optional(),
    },
    run: (client, args) =>
      client.get("/sessions", {
        status: args.status as string | undefined,
        limit: (args.limit as number | undefined) ?? DEFAULT_SESSION_LIMIT,
        offset: args.offset as number | undefined,
      }),
  },
  {
    name: "get_session_events",
    title: "Read a session timeline",
    readOnly: true,
    description:
      "Read one session's event timeline — tool calls, agent output, errors. This is the " +
      "primary tool for working out what a session actually did and where it went wrong. Returns one page; pass the response's cursor back to continue.",
    inputSchema: {
      session_id: sessionId,
      limit: z.number().int().min(1).max(MAX_EVENT_LIMIT).optional(),
      cursor,
    },
    run: (client, args) =>
      client.get(`/sessions/${encodeURIComponent(args.session_id as string)}/events`, {
        limit: (args.limit as number | undefined) ?? DEFAULT_EVENT_LIMIT,
        cursor: args.cursor as string | undefined,
      }),
  },
  {
    name: "get_session_messages",
    title: "Read session messages",
    readOnly: true,
    description:
      "Read the prompt/response messages exchanged in one session, without the tool-call " +
      "detail that get_session_events includes.",
    inputSchema: {
      session_id: sessionId,
      limit: z.number().int().min(1).max(MAX_MESSAGE_LIMIT).optional(),
      cursor,
    },
    run: (client, args) =>
      client.get(`/sessions/${encodeURIComponent(args.session_id as string)}/messages`, {
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      }),
  },
  {
    name: "get_session_diff",
    title: "Read a session's diff",
    readOnly: true,
    description: "Read the working-tree diff a session produced, as a list of changed files.",
    inputSchema: { session_id: sessionId },
    run: (client, args) =>
      client.get(`/sessions/${encodeURIComponent(args.session_id as string)}/diff`),
  },
  {
    name: "list_automation_runs",
    title: "List automation invocations",
    readOnly: true,
    description:
      "List one automation's recent invocations with their status. Use to check whether a " +
      "scheduled automation fired, skipped, or failed.",
    inputSchema: {
      automation_id: automationId,
      limit: z.number().int().min(1).max(MAX_SESSION_LIMIT).optional(),
    },
    run: (client, args) =>
      client.get(`/automations/${encodeURIComponent(args.automation_id as string)}/invocations`, {
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "get_automation_run",
    title: "Read one automation run",
    readOnly: true,
    description:
      "Read a single automation invocation, including the child sessions it launched. Pair " +
      "with get_session_events on a child id to see what that run actually did.",
    inputSchema: {
      automation_id: automationId,
      run_id: z.string().min(1).describe("Run id, as returned by list_automation_runs"),
    },
    run: (client, args) =>
      client.get(
        `/automations/${encodeURIComponent(args.automation_id as string)}` +
          `/runs/${encodeURIComponent(args.run_id as string)}`
      ),
  },
  {
    name: "create_automation",
    title: "Create an automation",
    readOnly: false,
    description:
      "Create an automation: saved instructions the installation runs on a cron schedule, or " +
      "when a GitHub, Linear, Slack, Sentry, or webhook event arrives — a sentry trigger " +
      "additionally needs the sentry_client_secret. It is created enabled, " +
      "so a schedule automation starts firing at the next occurrence of its cron — give it the " +
      "schedule it should keep rather than creating it and fixing the cron afterwards, which " +
      "this credential cannot do. Returns the stored automation, whose id trigger_automation " +
      "takes, and for a webhook trigger the key that calls it, which is shown this once only. " +
      "Targets have to be repositories and environments the owner may already use.",
    inputSchema: {
      name: z.string().min(1).describe("Display name, as the dashboard lists it"),
      instructions: z
        .string()
        .min(1)
        .max(MAX_AUTOMATION_INSTRUCTIONS_LENGTH)
        .describe("The prompt every run of this automation executes"),
      trigger_type: automationTriggerTypeSchema
        .optional()
        .describe("What starts a run. Defaults to schedule."),
      schedule_cron: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Five-field cron expression. Required by a schedule trigger and refused on every other."
        ),
      schedule_tz: z
        .string()
        .min(1)
        .optional()
        .describe(
          "IANA timezone the cron is read in, such as Europe/Berlin. Defaults to UTC, which is " +
            "rarely the hour a person means — pass the owner's timezone when the run time matters."
        ),
      event_type: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Event that starts a run, such as pull_request.opened. Required by the event-driven " +
            "trigger types, which name the events they accept when one is wrong."
        ),
      trigger_config: triggerConfigSchema
        .optional()
        .describe("Conditions an event must match to start a run. Event-driven triggers only."),
      sentry_client_secret: sentryClientSecretSchema
        .optional()
        .describe(
          "Sentry's client secret for the webhook it will call, from the Sentry integration " +
            "that sends the events. A sentry trigger is refused without it; every other trigger " +
            "ignores it. Stored encrypted and never read back."
        ),
      repositories: z
        .array(
          z.object({
            repo_owner: repoOwner,
            repo_name: repoName,
            base_branch: z
              .string()
              .min(1)
              .optional()
              .describe("Branch each run starts from. Defaults to the repository's own default."),
          })
        )
        .max(MAX_AUTOMATION_REPOSITORIES)
        .optional()
        .describe(
          "Repositories to run against, one session each. A repository-scoped event trigger " +
            "takes exactly one; fanning out over several requires a schedule trigger."
        ),
      environment_ids: z
        .array(z.string().min(1))
        .optional()
        .describe("Environments (env_…) to fan out over, one workspace session each"),
      harness: harnessIdSchema
        .optional()
        .describe("Agent harness each run uses. Defaults to the installation's built-in harness."),
      model: z
        .string()
        .min(1)
        .optional()
        .describe("Model each run uses. Defaults to the installation's default model."),
      reasoning_effort: z
        .string()
        .min(1)
        .optional()
        .describe("Reasoning effort, where the selected model takes one"),
    },
    run: (client, args) => {
      const triggerType = args.trigger_type as string | undefined;
      const scheduleCron = args.schedule_cron as string | undefined;
      // The control plane demands a timezone alongside a cron and refuses both
      // on an event trigger, so the default applies only where one is required
      // — defaulting unconditionally would turn a missing field into a 400.
      const scheduleTz =
        (args.schedule_tz as string | undefined) ??
        ((triggerType ?? "schedule") === "schedule" && scheduleCron !== undefined
          ? "UTC"
          : undefined);
      const repositories = (args.repositories as AutomationRepositoryArg[] | undefined)?.map(
        (repository) => ({
          repoOwner: repository.repo_owner,
          repoName: repository.repo_name,
          baseBranch: repository.base_branch ?? null,
        })
      );

      // Undefined fields drop out of the serialized body, which is what keeps
      // an omitted argument an omission rather than an explicitly empty value.
      return client.post("/automations", {
        name: args.name,
        instructions: args.instructions,
        triggerType,
        scheduleCron,
        scheduleTz,
        eventType: args.event_type,
        triggerConfig: args.trigger_config,
        sentryClientSecret: args.sentry_client_secret,
        repositories,
        environmentIds: args.environment_ids,
        harness: args.harness,
        model: args.model,
        reasoningEffort: args.reasoning_effort,
      });
    },
  },
  {
    name: "trigger_automation",
    title: "Run an automation now",
    readOnly: false,
    description:
      "Start one run of an automation immediately, outside its schedule. Returns the invocation " +
      "id and the sessions it launched; follow those with get_automation_run, or with " +
      "get_session_events on a session id. The schedule is untouched — a manual run is an extra " +
      "run, not a replacement for the next scheduled one. Fails with 409 while a run of this " +
      "automation is already active, and does not queue behind it.",
    inputSchema: { automation_id: automationId },
    run: (client, args) =>
      client.post(`/automations/${encodeURIComponent(args.automation_id as string)}/trigger`, {}),
  },
  {
    name: "list_skills",
    title: "List managed skills",
    readOnly: true,
    description:
      "List the installation's managed skills alphabetically. Use to find a skill id before " +
      "updating it, to see which skills are enabled, and to see which repository each was " +
      "imported from. Returns one page; pass the response's nextCursor back to continue.",
    inputSchema: {
      limit: z.number().int().min(1).max(SKILL_LIST_PAGE_SIZE).optional(),
      cursor,
    },
    run: (client, args) =>
      client.get("/skills", {
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      }),
  },
  {
    name: "import_skill_from_git",
    title: "Create a skill from a repository",
    readOnly: false,
    description:
      "Create a managed skill from a SKILL.md in a Git repository. Previews the source and " +
      "stores it in one step. Fails if a skill of that name already exists — use " +
      "update_skill_from_git to re-import that one instead. The skill is created enabled, but " +
      "its assignments are what decide which sessions load it.",
    inputSchema: {
      repo_owner: repoOwner,
      repo_name: repoName,
      ref: importRef,
      subdirectory: z
        .string()
        .optional()
        .describe("Directory holding SKILL.md, relative to the repository root"),
      name: z
        .string()
        .optional()
        .describe("Overrides the name derived from the source's own frontmatter"),
      assignments: z
        .array(
          z.union([
            z.object({ type: z.literal("global") }),
            z.object({
              type: z.literal("repository"),
              repository: z.object({ repoOwner, repoName }),
            }),
            z.object({ type: z.literal("environment"), environmentId: z.string().min(1) }),
          ])
        )
        .optional()
        .describe(
          "Where the skill applies. Omitted, it is stored unassigned and no session loads it."
        ),
    },
    run: async (client, args) => {
      const source = {
        repository: { repoOwner: args.repo_owner as string, repoName: args.repo_name as string },
        ref: (args.ref as string | undefined) ?? null,
        subdirectory: (args.subdirectory as string | undefined) ?? null,
      };
      const name = (args.name as string | undefined) ?? null;

      const preview = parsePreview(await client.post("/skills/import/preview", { source, name }));
      if (!preview.nameAvailable) {
        // Importing would 409 on the name. Say which tool takes it from here
        // rather than making the model read that out of a status code.
        throw new Error(
          `A skill named "${preview.name}" already exists. Find its id with list_skills and ` +
            "call update_skill_from_git to re-import it, or pass a different name."
        );
      }

      const imported = await client.post("/skills/import", {
        source,
        name,
        assignments: (args.assignments as unknown[] | undefined) ?? [],
        ...confirmation(preview),
      });
      return importReport(parseStoredSkill(imported), preview);
    },
  },
  {
    name: "update_skill_from_git",
    title: "Update a skill from its repository",
    readOnly: false,
    // Not additive: this moves the skill's current revision, and that is what
    // future sessions load. The old revision surviving in the history makes it
    // recoverable, not additive.
    destructive: true,
    description:
      "Re-import an existing skill from the repository it was imported from, adding a revision " +
      "with whatever the source says now. The repository and subdirectory come from the skill's " +
      "recorded provenance; only the ref may move. Reports revisionCreated false when the source " +
      "had not changed. Fails on a skill that was authored in the editor rather than imported. " +
      "Reads the skill before writing it, so it needs skills.read alongside skills.manage.",
    inputSchema: {
      skill_id: z.string().min(1).describe("Skill id, as returned by list_skills"),
      ref: importRef,
    },
    run: async (client, args) => {
      const skillId = encodeURIComponent(args.skill_id as string);
      const ref = (args.ref as string | undefined) ?? null;

      // Read the revision first: it is the If-Match the re-import needs, and
      // pinning it here means a concurrent edit fails the write rather than
      // silently losing itself in a new revision.
      const current = parseStoredSkill(await client.get(`/skills/${skillId}`));
      const preview = parsePreview(
        await client.post(`/skills/${skillId}/reimport/preview`, { ref })
      );

      const applied = await client.post(
        `/skills/${skillId}/reimport`,
        { ref, ...confirmation(preview) },
        { headers: { "If-Match": `"${current.currentRevisionId}"` } }
      );
      const revisionCreated =
        typeof applied === "object" && applied !== null && "revisionCreated" in applied
          ? Boolean((applied as { revisionCreated: unknown }).revisionCreated)
          : null;
      return {
        ...importReport(parseStoredSkill(applied), preview),
        previousRevisionId: current.currentRevisionId,
        revisionCreated,
      };
    },
  },
];
