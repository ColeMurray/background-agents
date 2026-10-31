/**
 * The tool surface.
 *
 * Each tool calls control-plane routes that accept personal access tokens. What a call may do is
 * decided there: the token acts with its owner's permissions narrowed to its grant, so a tool the
 * token was not granted the permissions for fails with the permission it lacks. `requires` names
 * those permissions, so the model can say which grant is missing before it tries.
 */

import { harnessIdSchema } from "@open-inspect/shared/harnesses";
import { automationTriggerTypeSchema, triggerConfigSchema } from "@open-inspect/shared/triggers";
import {
  createAutomationRequestSchema,
  MAX_AUTOMATION_INSTRUCTIONS_LENGTH,
  MAX_AUTOMATION_INVOCATION_LIST_LIMIT,
  MAX_AUTOMATION_LIST_PAGE_SIZE,
  MAX_AUTOMATION_NAME_LENGTH,
  MAX_AUTOMATION_REPOSITORIES,
  sentryClientSecretSchema,
  type CreateAutomationRequest,
} from "@open-inspect/shared/types/automations";
import type {
  importSkillInputSchema,
  reimportSkillInputSchema,
  reimportSkillPreviewInputSchema,
  skillImportPreviewInputSchema,
} from "@open-inspect/shared/types/skills";
import {
  reimportSkillResponseSchema,
  SKILL_LIST_PAGE_SIZE,
  skillImportPreviewResponseSchema,
  skillImportProvenanceSchema,
  skillImportSourceSchema,
  skillImportWarningSchema,
  skillResponseSchema,
  skillSchema,
} from "@open-inspect/shared/types/skills";
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

/** A tool as the server registers it, whatever the shape of its arguments. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** The grant a token needs for this tool, as the tool description states it. */
  requires: string;
  /** Drives the MCP `readOnlyHint`, a hint a client may use to decide what to prompt for. */
  readOnly: boolean;
  /**
   * Drives the MCP `destructiveHint`, which means additive-only when false.
   * Set it on a write that replaces something a later reader will act on, even
   * where the previous value remains recoverable. Meaningless on a read tool.
   */
  destructive?: true;
  inputSchema: z.ZodRawShape;
  /** Validates `args` against `inputSchema`, then runs the tool on what that produced. */
  run(client: ControlPlaneClient, args: unknown): Promise<unknown>;
}

/** A tool as it is written: its handler receives exactly what its schema produces. */
interface ToolSpec<Shape extends z.ZodRawShape> extends Omit<
  ToolDefinition,
  "inputSchema" | "run"
> {
  inputSchema: Shape;
  run(client: ControlPlaneClient, args: z.output<z.ZodObject<Shape>>): Promise<unknown>;
}

/**
 * The one place a tool's argument type is erased for the registry. Parsing here rather than
 * trusting the caller keeps the handler's type true for every caller: the SDK validates first,
 * but a test or a future caller that does not still cannot hand the handler something else.
 */
function defineTool<const Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): ToolDefinition {
  const schema = z.object(spec.inputSchema);
  return { ...spec, run: async (client, args) => spec.run(client, schema.parse(args)) };
}

const sessionId = z.string().min(1).describe("Session id, as returned by list_sessions");

const automationId = z
  .string()
  .min(1)
  .describe("Automation id, as returned by list_automations or create_automation");

/**
 * The control plane's skill responses, projected from its own schemas onto what these tools read.
 *
 * Unknown keys are stripped at every level rather than refused, since this server is built on a
 * laptop and may talk to a deployment a version ahead; every field the tools do read still has to
 * match its shared contract.
 */
const importPreviewSchema = skillImportPreviewResponseSchema
  .pick({ name: true, nameAvailable: true, revisionSha256: true, totalBytes: true })
  .extend({
    source: skillImportSourceSchema.strip(),
    // Shown to the model and never acted on, so a code a newer deployment adds passes through.
    warnings: z.array(skillImportWarningSchema.extend({ code: z.string() }).strip()),
    // Paths only: the contents are what the report deliberately leaves out.
    files: z.array(
      skillImportPreviewResponseSchema.shape.files.element.pick({ path: true }).strip()
    ),
  })
  .strip();

type ImportPreview = z.output<typeof importPreviewSchema>;

/** A stored skill's identity and recorded provenance, without its body or files. */
const storedSkillSchema = skillSchema
  .pick({
    id: true,
    name: true,
    description: true,
    enabled: true,
    currentRevisionId: true,
    revisionNumber: true,
  })
  .extend({ source: skillImportProvenanceSchema.strip().nullable().optional().default(null) })
  .strip();

type StoredSkill = z.output<typeof storedSkillSchema>;

const skillReadSchema = skillResponseSchema.extend({ skill: storedSkillSchema }).strip();
const reimportResultSchema = reimportSkillResponseSchema
  .extend({ skill: storedSkillSchema })
  .strip();

function parseResponse<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  what: string
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Control plane returned an unrecognized ${what}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Pin a confirmation to the bytes the preview showed.
 *
 * The control plane re-reads the source when it applies an import and refuses
 * to store anything that no longer matches these digests. Previewing and
 * confirming in one tool call leaves only a race to catch, and a moved source
 * surfaces as a 409 rather than as an unreviewed import.
 */
function confirmation(preview: ImportPreview) {
  return {
    expectedCommitSha: preview.source.commitSha,
    expectedSourceSha256: preview.source.sourceSha256,
    expectedRevisionSha256: preview.revisionSha256,
  };
}

/**
 * What both write tools report back, without the skill body or file contents. Provenance is
 * the skill's as stored: a re-import whose content is unchanged keeps the revision, and the
 * commit, it already had, so the previewed commit would claim a move that never happened.
 */
function importReport(skill: StoredSkill, preview: ImportPreview) {
  const { source, ...identity } = skill;
  return {
    skill: identity,
    source,
    files: preview.files.map((file) => file.path),
    totalBytes: preview.totalBytes,
    warnings: preview.warnings,
  };
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
  defineTool({
    name: "list_sessions",
    requires: "sessions.read",
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
        status: args.status,
        limit: args.limit ?? DEFAULT_SESSION_LIMIT,
        offset: args.offset,
      }),
  }),
  defineTool({
    name: "get_session_events",
    requires: "sessions.read",
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
      client.get(`/sessions/${encodeURIComponent(args.session_id)}/events`, {
        limit: args.limit ?? DEFAULT_EVENT_LIMIT,
        cursor: args.cursor,
      }),
  }),
  defineTool({
    name: "get_session_messages",
    requires: "sessions.read",
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
      client.get(`/sessions/${encodeURIComponent(args.session_id)}/messages`, {
        limit: args.limit,
        cursor: args.cursor,
      }),
  }),
  defineTool({
    name: "get_session_diff",
    requires: "sessions.read",
    title: "List a session's changed files",
    readOnly: true,
    description:
      "Read the manifest of the latest working-tree diff a session produced: its revisionId " +
      "under current, and per repository the changed files with their id, path, and status. " +
      "The manifest carries no patches; read what changed in a file with get_session_diff_file. " +
      "current is null when the session has captured no diff.",
    inputSchema: { session_id: sessionId },
    run: (client, args) => client.get(`/sessions/${encodeURIComponent(args.session_id)}/diff`),
  }),
  defineTool({
    name: "get_session_diff_file",
    requires: "sessions.read",
    title: "Read one file's patch",
    readOnly: true,
    description:
      "Read the patch for one file in a session's diff. Take revision_id and file_id from " +
      "get_session_diff; a revision the session has since replaced is refused, so read the " +
      "manifest again and use its current ids.",
    inputSchema: {
      session_id: sessionId,
      revision_id: z
        .string()
        .min(1)
        .describe("The diff revision, current.revisionId from get_session_diff"),
      file_id: z
        .string()
        .min(1)
        .describe("The file, current.repositories[].files[].id from get_session_diff"),
    },
    run: (client, args) =>
      client.get(
        `/sessions/${encodeURIComponent(args.session_id)}/diff` +
          `/${encodeURIComponent(args.revision_id)}/files/${encodeURIComponent(args.file_id)}`
      ),
  }),
  defineTool({
    name: "list_automations",
    requires: "automations.read",
    title: "List automations",
    readOnly: true,
    description:
      "List the installation's automations with their trigger, targets, and last few " +
      "invocations. Use to find an automation id before triggering one or reading its runs, and " +
      "to see which automations are enabled. Returns one page; pass the response's nextCursor " +
      "back to continue.",
    inputSchema: {
      search: z
        // Trimmed, and blank refused: the route trims this itself and drops the
        // filter when nothing is left, which would answer a blank search with a
        // full unfiltered page that reads as a filtered one. Capped where the
        // route caps it, so an over-long needle fails here rather than as a 400.
        .string()
        .trim()
        .min(1)
        .max(MAX_AUTOMATION_NAME_LENGTH)
        .optional()
        .describe("Only automations whose name contains this text, case-insensitively"),
      repo_owner: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Only automations targeting this owner. May contain `/` where the provider nests " +
            "namespaces, as GitLab subgroups do."
        ),
      repo_name: z
        .string()
        .min(1)
        .optional()
        .describe("Only automations targeting this repository name. Usable without repo_owner."),
      limit: z.number().int().min(1).max(MAX_AUTOMATION_LIST_PAGE_SIZE).optional(),
      cursor,
    },
    run: (client, args) =>
      client.get("/automations", {
        search: args.search,
        repoOwner: args.repo_owner,
        repoName: args.repo_name,
        limit: args.limit,
        cursor: args.cursor,
      }),
  }),
  defineTool({
    name: "list_automation_invocations",
    requires: "automations.read",
    title: "List automation invocations",
    readOnly: true,
    description:
      "List one automation's recent invocations, newest first: one per firing, each with the " +
      "child runs it launched, one per target. Use to check whether an automation fired, " +
      "skipped, or failed. A skipped invocation launched nothing and has no runs. Read one " +
      "child run with get_automation_run, passing invocations[].runs[].id.",
    inputSchema: {
      automation_id: automationId,
      limit: z.number().int().min(1).max(MAX_AUTOMATION_INVOCATION_LIST_LIMIT).optional(),
    },
    run: (client, args) =>
      client.get(`/automations/${encodeURIComponent(args.automation_id)}/invocations`, {
        limit: args.limit,
      }),
  }),
  defineTool({
    name: "get_automation_run",
    requires: "automations.read",
    title: "Read one automation run",
    readOnly: true,
    description:
      "Read one child run of an automation: a single target's launch within an invocation, " +
      "with its status, failure reason, and the session it ran in. An invocation id is not a " +
      "run id. Pair with get_session_events on the run's sessionId to see what it actually did.",
    inputSchema: {
      automation_id: automationId,
      run_id: z
        .string()
        .min(1)
        .describe(
          "Child run id: invocations[].runs[].id from list_automation_invocations, or runs[].id " +
            "from trigger_automation"
        ),
    },
    run: (client, args) =>
      client.get(
        `/automations/${encodeURIComponent(args.automation_id)}` +
          `/runs/${encodeURIComponent(args.run_id)}`
      ),
  }),
  defineTool({
    name: "create_automation",
    requires:
      "automations.create and sessions.create, plus repositories.use or environments.use for its targets",
    title: "Create an automation",
    readOnly: false,
    description:
      "Create an automation: saved instructions the installation runs on a cron schedule, or " +
      "when a GitHub, Linear, Slack, Sentry, or webhook event arrives — a sentry trigger " +
      "additionally needs the sentry_client_secret. It is created enabled, " +
      "so a schedule automation starts firing at the next occurrence of its cron — give it the " +
      "schedule it should keep rather than creating it and fixing the cron afterwards, which " +
      "no tool here can do. Returns the stored automation, whose id trigger_automation " +
      "takes, and for a webhook trigger the key that calls it, which is shown this once only. " +
      "Targets have to be repositories and environments the owner may already use.",
    inputSchema: {
      team_id: createAutomationRequestSchema.shape.teamId.describe(
        "Team (team_…) that will own the automation, which the owner must belong to. Required " +
          "where the workspace requires a team on creation; omitted, the automation is personal."
      ),
      name: z
        .string()
        .min(1)
        .max(MAX_AUTOMATION_NAME_LENGTH)
        .describe("Display name, as the dashboard lists it"),
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
      const triggerType = args.trigger_type;
      const scheduleCron = args.schedule_cron;
      // The control plane demands a timezone alongside a cron and refuses both
      // on an event trigger, so the default applies only where one is required
      // — defaulting unconditionally would turn a missing field into a 400.
      const scheduleTz =
        args.schedule_tz ??
        ((triggerType ?? "schedule") === "schedule" && scheduleCron !== undefined
          ? "UTC"
          : undefined);
      const repositories = args.repositories?.map((repository) => ({
        repoOwner: repository.repo_owner,
        repoName: repository.repo_name,
        baseBranch: repository.base_branch ?? null,
      }));

      // Undefined fields drop out of the serialized body, which is what keeps
      // an omitted argument an omission rather than an explicitly empty value.
      return client.post("/automations", {
        teamId: args.team_id,
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
      } satisfies CreateAutomationRequest);
    },
  }),
  defineTool({
    name: "trigger_automation",
    requires:
      "automations.trigger.own for automations you run, or automations.trigger.any, plus " +
      "sessions.create, and repositories.use or environments.use for its targets",
    title: "Run an automation now",
    readOnly: false,
    description:
      "Start one invocation of an automation immediately, outside its schedule. Returns the " +
      "invocationId and its child runs, one per target; read a run with get_automation_run " +
      "using runs[].id, or its session with get_session_events on the run's sessionId. The run " +
      "uses no permission the token was not granted, even where the automation's owner holds " +
      "it. The schedule is untouched — a manual run is an extra run, not a replacement for the " +
      "next scheduled one. Fails with 409 while a run of this automation is already active, " +
      "and does not queue behind it.",
    inputSchema: { automation_id: automationId },
    run: (client, args) =>
      client.post(`/automations/${encodeURIComponent(args.automation_id)}/trigger`, {}),
  }),
  defineTool({
    name: "list_skills",
    requires: "skills.read",
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
        limit: args.limit,
        cursor: args.cursor,
      }),
  }),
  defineTool({
    name: "import_skill_from_git",
    requires: "skills.read and skills.manage",
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
      const request = {
        source: {
          repository: { repoOwner: args.repo_owner, repoName: args.repo_name },
          ref: args.ref ?? null,
          subdirectory: args.subdirectory ?? null,
        },
        name: args.name ?? null,
      } satisfies z.input<typeof skillImportPreviewInputSchema>;

      const preview = parseResponse(
        importPreviewSchema,
        await client.post("/skills/import/preview", request),
        "import preview"
      );
      if (!preview.nameAvailable) {
        // Importing would 409 on the name. Say which tool takes it from here
        // rather than making the model read that out of a status code.
        throw new Error(
          `A skill named "${preview.name}" already exists. Find its id with list_skills and ` +
            "call update_skill_from_git to re-import it, or pass a different name."
        );
      }

      const imported = await client.post("/skills/import", {
        ...request,
        assignments: args.assignments ?? [],
        ...confirmation(preview),
      } satisfies z.input<typeof importSkillInputSchema>);
      return importReport(parseResponse(skillReadSchema, imported, "skill").skill, preview);
    },
  }),
  defineTool({
    name: "update_skill_from_git",
    requires: "skills.read and skills.manage",
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
      "had not changed. Fails on a skill that was authored in the editor rather than imported.",
    inputSchema: {
      skill_id: z.string().min(1).describe("Skill id, as returned by list_skills"),
      ref: importRef,
    },
    run: async (client, args) => {
      const skillId = encodeURIComponent(args.skill_id);
      const ref = args.ref ?? null;

      // Read the revision first: it is the If-Match the re-import needs, and
      // pinning it here means a concurrent edit fails the write rather than
      // silently losing itself in a new revision.
      const current = parseResponse(
        skillReadSchema,
        await client.get(`/skills/${skillId}`),
        "skill"
      ).skill;
      const preview = parseResponse(
        importPreviewSchema,
        await client.post(`/skills/${skillId}/reimport/preview`, {
          ref,
        } satisfies z.input<typeof reimportSkillPreviewInputSchema>),
        "import preview"
      );

      const applied = parseResponse(
        reimportResultSchema,
        await client.post(
          `/skills/${skillId}/reimport`,
          { ref, ...confirmation(preview) } satisfies z.input<typeof reimportSkillInputSchema>,
          { headers: { "If-Match": `"${current.currentRevisionId}"` } }
        ),
        "re-import result"
      );
      return {
        ...importReport(applied.skill, preview),
        previousRevisionId: current.currentRevisionId,
        revisionCreated: applied.revisionCreated,
      };
    },
  }),
];
