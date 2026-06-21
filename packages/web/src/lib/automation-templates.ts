/**
 * Static, code-defined catalog of automation "ideas" shown in the templates
 * gallery. Adding a template pre-fills the existing Create Automation form
 * (`/automations/new?template=<id>`); it never creates or runs anything on its
 * own. Repository is intentionally never pre-filled so the existing
 * repo-required-at-creation invariant is untouched.
 */

import {
  DEFAULT_MODEL,
  getValidModelOrDefault,
  isValidReasoningEffort,
  type AutomationTriggerType,
} from "@open-inspect/shared";
import type { AutomationFormValues } from "@/components/automations/automation-form";

export type TemplateCategory =
  | "popular"
  | "code-review"
  | "security"
  | "incidents"
  | "data-research";

/**
 * The create-form fields a template pre-fills. Repository fields and
 * `scheduleTz` are statically excluded (repo is always the user's choice; the
 * form's timezone default applies), and `name`/`triggerType`/`instructions` are
 * required so every template is complete by construction — making these
 * invariants compile-time rather than test-only.
 */
export type AutomationTemplatePrefill = Omit<
  Partial<AutomationFormValues>,
  "repoOwner" | "repoName" | "baseBranch" | "scheduleTz"
> & {
  name: string;
  triggerType: AutomationTriggerType;
  instructions: string;
};

export interface AutomationTemplate {
  /** Stable slug used in `?template=<id>`. */
  id: string;
  title: string;
  description: string;
  categories: TemplateCategory[];
  primaryOutput: "pr" | "slack";
  /**
   * Static "needs setup" copy surfaced on the card. Present when the template
   * requires configuration beyond picking a repository (Slack, Sentry secret,
   * GitHub event delivery). Informational only — the gallery performs no checks.
   */
  setupNote?: string;
  prefill: AutomationTemplatePrefill;
}

/** Curated category order. */
export const TEMPLATE_CATEGORIES: ReadonlyArray<{ id: TemplateCategory; label: string }> = [
  { id: "popular", label: "Popular" },
  { id: "code-review", label: "Code Review" },
  { id: "security", label: "Security" },
  { id: "incidents", label: "Incidents" },
  { id: "data-research", label: "Data & Research" },
];

// Conservative cadences to limit recurring cost. Both are ≥ the 15-minute floor.
const DAILY_9AM = "0 9 * * *";
const WEEKLY_MON_9AM = "0 9 * * 1";

/**
 * The starter catalog. Array order is curated and is the order templates appear
 * within each category (no sort applied) — the Popular ordering relies on it.
 */
export const automationTemplates: AutomationTemplate[] = [
  {
    id: "find-bugs",
    title: "Find bugs",
    description:
      "Analyze recent commits for high-severity correctness bugs and open a PR with safe fixes.",
    categories: ["popular", "code-review"],
    primaryOutput: "pr",
    prefill: {
      name: "Find bugs",
      triggerType: "schedule",
      scheduleCron: DAILY_9AM,
      instructions:
        "Review the most recent commits on this repository for high-severity correctness bugs — " +
        "logic errors, off-by-one mistakes, unhandled error cases, race conditions, and incorrect " +
        "edge-case handling — focusing on changes from roughly the last day.\n\n" +
        "For each issue you are confident about, implement a minimal, well-scoped fix. Open a single " +
        "pull request containing the fixes, with a clear description of each bug and why the change " +
        "is correct. Do not make unrelated refactors. If you find no high-confidence bugs, do not " +
        "open a pull request.",
    },
  },
  {
    id: "scan-vulnerabilities",
    title: "Scan codebase for vulnerabilities",
    description:
      "Run a scheduled application-security review and post validated high-impact findings to Slack.",
    categories: ["popular", "security"],
    primaryOutput: "slack",
    setupNote:
      "Posts to Slack — requires Slack agent notifications enabled and the bot invited to the channel.",
    prefill: {
      name: "Scan codebase for vulnerabilities",
      triggerType: "schedule",
      scheduleCron: WEEKLY_MON_9AM,
      // Security review benefits from a stronger model; coerced if the user hasn't enabled it.
      model: "anthropic/claude-opus-4-8",
      reasoningEffort: "high",
      instructions:
        "Perform an application-security review of this repository. Look for validated, exploitable " +
        "vulnerabilities with a realistic attack path — for example injection (SQL/command/template), " +
        "authentication or authorization flaws, insecure deserialization, SSRF, secrets committed to " +
        "the repository, and unsafe handling of untrusted input.\n\n" +
        "Only report issues you can substantiate with a concrete code path; avoid generic or " +
        "theoretical findings. When finished, post a concise summary of the medium/high/critical " +
        "findings (with file references and recommended fixes) to the #security Slack channel using " +
        "the slack-notify tool. If you find nothing credible, post a short “no new findings” note.",
    },
  },
  {
    id: "add-test-coverage",
    title: "Add test coverage",
    description: "Find high-risk, under-tested logic in recent changes, add tests, and open a PR.",
    categories: ["popular", "code-review"],
    primaryOutput: "pr",
    prefill: {
      name: "Add test coverage",
      triggerType: "schedule",
      scheduleCron: WEEKLY_MON_9AM,
      instructions:
        "Identify high-risk application logic in this repository that lacks adequate automated test " +
        "coverage, prioritizing recently changed files and core business logic.\n\n" +
        "Add focused unit or integration tests that capture the important behaviors and edge cases, " +
        "following the project's existing test conventions and framework, and make sure the new tests " +
        "pass. Open a pull request with the added tests and a short summary of what they cover and why. " +
        "Do not modify production code except where a trivial, clearly-correct change is required to " +
        "make code testable.",
    },
  },
  {
    id: "review-new-prs",
    title: "Review new PRs",
    description:
      "When a pull request is opened, review the diff and leave actionable review comments.",
    categories: ["popular", "code-review"],
    primaryOutput: "pr",
    setupNote:
      "Runs only when GitHub events reach this repo (GitHub App installed and the repo enabled for events).",
    prefill: {
      name: "Review new PRs",
      triggerType: "github_event",
      eventType: "pull_request.opened",
      instructions:
        "A pull request was opened; its number and details are shown above. Review it using the " +
        "GitHub CLI, which is already authenticated in this environment.\n\n" +
        "1. Read the changes with `gh pr diff <number>`.\n" +
        "2. Assess them for correctness bugs, security issues, missing tests, and deviations from the " +
        "project's conventions.\n" +
        "3. Post your feedback as a review on the existing PR with " +
        '`gh pr review <number> --comment --body "..."`. Lead with a short overall summary, then the ' +
        "most important issues with file/line references. For line-anchored comments you may use " +
        "`gh api repos/{owner}/{repo}/pulls/<number>/comments`.\n\n" +
        "Be concise and prioritize high-impact issues; do not nitpick formatting that automated tooling " +
        "already handles. Do not open a new pull request — comment on the existing one.",
    },
  },
  {
    id: "generate-docs",
    title: "Generate docs",
    description:
      "Create or update developer docs for recently changed or under-documented code, via a PR.",
    categories: ["code-review"],
    primaryOutput: "pr",
    prefill: {
      name: "Generate docs",
      triggerType: "schedule",
      scheduleCron: WEEKLY_MON_9AM,
      instructions:
        "Improve developer documentation for this repository. Find recently changed or " +
        "under-documented modules, public functions, and APIs, and create or update their " +
        "documentation (docstrings, README sections, or docs/ pages) to match the project's existing " +
        "style.\n\n" +
        "Keep documentation accurate to the current code. Open a pull request with the documentation " +
        "updates and a summary of what changed. Do not alter application behavior.",
    },
  },
  {
    id: "investigate-sentry",
    title: "Investigate Sentry issues",
    description: "When Sentry reports a new error, find the root cause and open a fix PR.",
    categories: ["security", "incidents"],
    primaryOutput: "pr",
    setupNote:
      "Requires a Sentry client secret at creation and completing the Sentry webhook setup shown afterward.",
    prefill: {
      name: "Investigate Sentry issues",
      triggerType: "sentry",
      eventType: "issue.created",
      instructions:
        "A Sentry error was reported (details are included above). Investigate the root cause in this " +
        "codebase: trace the stack trace to the responsible code, determine why the error occurs, and " +
        "identify the correct fix.\n\n" +
        "Implement a minimal fix and open a pull request that explains the root cause and the change. " +
        "If the issue cannot be safely fixed automatically, open a pull request with a clear write-up " +
        "of the root cause and a proposed approach instead.",
    },
  },
  {
    id: "triage-ci-failures",
    title: "Triage failed CI",
    description:
      "When a CI check suite fails, reproduce the failure locally, diagnose it, and report to Slack.",
    categories: ["incidents"],
    primaryOutput: "slack",
    setupNote:
      "Requires GitHub events for this repo and Slack agent notifications enabled with the bot in the channel.",
    prefill: {
      name: "Triage failed CI",
      triggerType: "github_event",
      eventType: "check_suite.completed",
      // Only fire on failed suites — avoids spawning a run on every green build.
      triggerConfig: {
        conditions: [{ type: "check_conclusion", operator: "eq", value: "failure" }],
      },
      instructions:
        "A CI check suite failed on this repository; the failing branch and commit are shown above.\n\n" +
        "Diagnose it from the codebase (this environment cannot read GitHub Actions logs):\n" +
        "1. Check out the failing commit/branch and run the project's build and test commands to " +
        "reproduce the failure locally.\n" +
        "2. Read the failing output and the related code to determine the most likely cause — a failing " +
        "test, a flaky test, a build/config error, or a real regression.\n\n" +
        "Post a concise summary — what failed, the most probable cause with file references, and a " +
        "recommended next step — to the #ci-alerts Slack channel using the slack-notify tool. Do not " +
        "open a pull request.",
    },
  },
  {
    id: "dependency-digest",
    title: "Weekly dependency digest",
    description:
      "Summarize dependency updates, changelogs, and advisories and post the digest to Slack.",
    categories: ["data-research"],
    primaryOutput: "slack",
    setupNote:
      "Posts to Slack — requires Slack agent notifications enabled and the bot invited to the channel.",
    prefill: {
      name: "Weekly dependency digest",
      triggerType: "schedule",
      scheduleCron: WEEKLY_MON_9AM,
      instructions:
        "Produce a weekly dependency digest for this repository. Use the project's package manager to " +
        "inspect dependencies — check for outdated packages and known security advisories (for example " +
        "`npm outdated` and `npm audit`, or the equivalent for this stack) — and review notable " +
        "changelog entries and deprecations for the versions in use.\n\n" +
        "Summarize the most important items and any recommended upgrades (call out breaking changes), " +
        "and post the digest to the #dependencies Slack channel using the slack-notify tool. Do not " +
        "modify dependencies or open a pull request — this is a read-only report.",
    },
  },
];

export function getTemplateById(id: string): AutomationTemplate | undefined {
  return automationTemplates.find((t) => t.id === id);
}

export function getTemplatesForCategory(category: TemplateCategory): AutomationTemplate[] {
  return automationTemplates.filter((t) => t.categories.includes(category));
}

export function getVisibleCategories(): Array<{ id: TemplateCategory; label: string }> {
  return TEMPLATE_CATEGORIES.filter((c) => getTemplatesForCategory(c.id).length > 0);
}

/**
 * Build the `initialValues` passed to the create form from a template's
 * pre-fill, resolving the suggested model against the user's enabled models.
 *
 * The model selector has no built-in fallback, so an unenabled suggested model
 * would render a broken/unselected control and be submitted verbatim. This
 * coerces the model to one that is actually enabled (preferring the suggestion,
 * then the system default, then the first enabled model) and drops a suggested
 * reasoning effort that the resolved model does not support.
 */
export function resolveTemplateInitialValues(
  prefill: Partial<AutomationFormValues>,
  enabledModels: string[]
): Partial<AutomationFormValues> {
  const { model, reasoningEffort, ...rest } = prefill;
  const result: Partial<AutomationFormValues> = { ...rest };

  // The model the form will actually use. When no model is suggested, the form
  // falls back to DEFAULT_MODEL, so reasoning is validated against that.
  let effectiveModel: string = DEFAULT_MODEL;

  if (model) {
    const enabled = new Set(enabledModels);
    // getValidModelOrDefault already guarantees a valid model id; the branches
    // below only resolve the *enabled* dimension (prefer the suggestion, then
    // the system default, then the first enabled model).
    const coerced = getValidModelOrDefault(model);
    const chosen = enabled.has(coerced)
      ? coerced
      : enabled.has(DEFAULT_MODEL)
        ? DEFAULT_MODEL
        : (enabledModels[0] ?? DEFAULT_MODEL);
    result.model = chosen;
    effectiveModel = chosen;
  }

  if (reasoningEffort && isValidReasoningEffort(effectiveModel, reasoningEffort)) {
    result.reasoningEffort = reasoningEffort;
  }

  return result;
}
