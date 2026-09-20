/**
 * Target clarification picker UI.
 *
 * When the classifier can't decide which repository or environment a Slack
 * message refers to, the bot posts a clarification message: the classifier's
 * ranked guesses as one-click quick-pick buttons, plus a picker over every
 * available target. This module owns that UI — the options Slack queries as
 * the user types, the quick-pick buttons, and the message blocks themselves.
 */

import { escapeMrkdwnText } from "@open-inspect/shared/slack";
import { getAvailableRepos, filterReposByQuery } from "./classifier/repos";
import { getEnvironmentById } from "./classifier/environments";
import type { Environment } from "@open-inspect/shared/types/environments";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import { loadTargetCatalog, type TargetCatalog } from "./classifier/catalog";
import { MAX_REPO_SUGGESTION_OPTIONS } from "./app-home/constants";
import { plainTextOption } from "./slack-options";
import {
  NO_REPOSITORY_TARGET_LABEL,
  NO_REPOSITORY_TARGET_VALUE,
  parseTargetValue,
  targetLabel,
  targetValue,
  type SlackSessionTarget,
} from "./targets";
import type {
  SlackActionsBlock,
  SlackButtonElement,
  SlackExternalSelectElement,
  SlackSectionBlock,
  SlackSelectOption,
  SlackSelectOptionGroup,
  SlackStaticSelectElement,
} from "./slack-blocks";
import type { Env } from "./types";

/**
 * Action ID for the target picker shown when the classifier can't decide what
 * a message refers to. The picker is an external_select, so the same ID is
 * matched both for option suggestions (block_suggestion) and selection
 * (block_actions). The wire value predates environments and must stay stable
 * so pickers on already-posted messages keep working.
 */
export const SELECT_TARGET_ACTION_ID = "select_repo";

/**
 * Action ID prefix for the one-click quick-pick buttons that surface the
 * classifier's ranked alternatives. Routed through the same selection path as
 * the picker; each button gets a unique suffix via {@link quickPickActionId}.
 * Wire value kept stable for already-posted messages, like the picker's.
 */
export const SELECT_TARGET_QUICK_PICK_ACTION_ID = "select_repo_quick_pick";
const TARGET_PICKER_BLOCK_ID_PREFIX = "target_picker:";
const TARGET_QUICK_PICK_BLOCK_ID_PREFIX = "target_quick_picks:";
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function targetPickerBlockId(requestId: string): string {
  return `${TARGET_PICKER_BLOCK_ID_PREFIX}${requestId}`;
}

export function targetQuickPickBlockId(requestId: string): string {
  return `${TARGET_QUICK_PICK_BLOCK_ID_PREFIX}${requestId}`;
}

export function parseTargetInteractionRequestId(
  blockId: string,
  source: "picker" | "quick_pick"
): string | null {
  const prefix =
    source === "picker" ? TARGET_PICKER_BLOCK_ID_PREFIX : TARGET_QUICK_PICK_BLOCK_ID_PREFIX;
  if (!blockId.startsWith(prefix)) return null;
  const requestId = blockId.slice(prefix.length);
  return REQUEST_ID_PATTERN.test(requestId) ? requestId : null;
}

/** Unique per-button action_id; Slack requires action_id uniqueness within an actions block. */
export function quickPickActionId(index: number): string {
  return `${SELECT_TARGET_QUICK_PICK_ACTION_ID}:${index}`;
}

/**
 * Collapse a quick-pick's per-button action_id back to the bare constant so the
 * interactions handler can match it; other action_ids pass through unchanged.
 */
export function baseActionId(actionId: string): string {
  return actionId.startsWith(`${SELECT_TARGET_QUICK_PICK_ACTION_ID}:`)
    ? SELECT_TARGET_QUICK_PICK_ACTION_ID
    : actionId;
}

/**
 * Cap on quick-pick buttons in the clarification message. The classifier rarely
 * returns more, and the actions block shouldn't become a wall of buttons — the
 * searchable picker covers everything beyond the top guesses.
 */
export const MAX_TARGET_QUICK_PICKS = 5;

function toRepoSelectOption(repo: RepoConfig): SlackSelectOption {
  return {
    text: plainTextOption(repo.displayName),
    description: plainTextOption(repo.description),
    value: repo.id,
  };
}

function toEnvironmentSelectOption(environment: Environment): SlackSelectOption {
  const repositoryCount = environment.repositories.length;
  return {
    text: plainTextOption(environment.name),
    description: plainTextOption(
      environment.description ||
        `${repositoryCount} ${repositoryCount === 1 ? "repository" : "repositories"}`
    ),
    value: targetValue({ kind: "environment", environment }),
  };
}

function toNoRepositorySelectOption(): SlackSelectOption {
  return {
    text: plainTextOption(NO_REPOSITORY_TARGET_LABEL),
    description: plainTextOption("Start without cloning a repository"),
    value: NO_REPOSITORY_TARGET_VALUE,
  };
}

/**
 * Filter environments by a free-text query against their name
 * (case-insensitive), mirroring {@link filterReposByQuery}.
 */
function filterEnvironmentsByQuery(
  environments: Environment[],
  query: string | undefined
): Environment[] {
  const normalizedQuery = query?.trim().toLowerCase();
  if (!normalizedQuery) {
    return environments;
  }
  return environments.filter((environment) =>
    environment.name.toLowerCase().includes(normalizedQuery)
  );
}

/**
 * Resolve a selected option/button value back to a launchable target against
 * the live lists, or null when it no longer exists (deleted environment, repo
 * access revoked, stale message). Lives here because this module mints the
 * values it resolves.
 */
export async function resolveTargetValue(
  env: Env,
  value: string,
  traceId?: string
): Promise<SlackSessionTarget | null> {
  const ref = parseTargetValue(value);
  if (ref.kind === "none") {
    return { kind: "none" };
  }
  if (ref.kind === "environment") {
    const environment = await getEnvironmentById(env, ref.environmentId, traceId);
    return environment ? { kind: "environment", environment } : null;
  }
  const repos = await getAvailableRepos(env, traceId);
  const repo = repos.find((r) => r.id === ref.repoId);
  return repo ? { kind: "repository", repo } : null;
}

/**
 * The body of a block_suggestion response: flat options while the workspace is
 * repository-only, or grouped options once environments exist (Slack accepts
 * exactly one of the two shapes).
 */
export type TargetClarificationOptions =
  | { options: SlackSelectOption[] }
  | { option_groups: SlackSelectOptionGroup[] };

/** Number of options in either response shape (for logging). */
export function countClarificationOptions(response: TargetClarificationOptions): number {
  return "options" in response
    ? response.options.length
    : response.option_groups.reduce((sum, group) => sum + group.options.length, 0);
}

export function getTargetCatalogNotice(catalog: TargetCatalog): string {
  return catalog.repos.length === 0 && catalog.environments.length === 0
    ? "\n\nNo repositories or environments are currently available. You can continue without one; if you expected other targets, check the integration configuration."
    : "";
}

function buildGroupedOptions(
  environments: Environment[],
  repos: RepoConfig[]
): TargetClarificationOptions {
  if (environments.length === 0) {
    return {
      options: [toNoRepositorySelectOption(), ...repos.map(toRepoSelectOption)],
    };
  }
  const groups: SlackSelectOptionGroup[] = [
    {
      label: { type: "plain_text", text: "Environments" },
      options: environments.map(toEnvironmentSelectOption),
    },
  ];
  if (repos.length > 0) {
    groups.push({
      label: { type: "plain_text", text: "Repositories" },
      options: repos.map(toRepoSelectOption),
    });
  }
  groups.push({
    label: { type: "plain_text", text: "Other" },
    options: [toNoRepositorySelectOption()],
  });
  return { option_groups: groups };
}

/**
 * Options for the clarification picker's external_select. Slack queries this as
 * the user types; we filter environments on name and repositories on full name,
 * always retain No repository, and cap at Slack's per-response limit
 * (environments first — the list is short). With min_query_length 0 the
 * unfiltered list shows as soon as the menu opens, and typing surfaces any of
 * the remaining targets.
 */
export async function getTargetClarificationOptions(
  env: Env,
  query: string | undefined,
  traceId?: string
): Promise<TargetClarificationOptions> {
  const catalog = await loadTargetCatalog(env, traceId);
  const remainingAfterNoRepository = MAX_REPO_SUGGESTION_OPTIONS - 1;
  const matchedEnvironments = filterEnvironmentsByQuery(catalog.environments, query).slice(
    0,
    remainingAfterNoRepository
  );
  const matchedRepos = filterReposByQuery(catalog.repos, query).slice(
    0,
    remainingAfterNoRepository - matchedEnvironments.length
  );
  return buildGroupedOptions(matchedEnvironments, matchedRepos);
}

function buildTargetPickerAccessory(
  catalog: TargetCatalog
): SlackStaticSelectElement | SlackExternalSelectElement {
  const { repos, environments } = catalog;
  const total = repos.length + environments.length + 1;
  const placeholder = {
    type: "plain_text" as const,
    text: "Select a target",
  };

  if (total <= MAX_REPO_SUGGESTION_OPTIONS) {
    return {
      type: "static_select",
      placeholder,
      action_id: SELECT_TARGET_ACTION_ID,
      ...buildGroupedOptions(environments, repos),
    };
  }

  return {
    type: "external_select",
    placeholder,
    // 0 so the list appears on open; typing filters across all targets.
    min_query_length: 0,
    action_id: SELECT_TARGET_ACTION_ID,
  };
}

/** Short button text for a target. */
function targetDisplayName(target: SlackSessionTarget): string {
  switch (target.kind) {
    case "repository":
      return target.repo.displayName;
    case "environment":
      return target.environment.name;
    case "none":
      return NO_REPOSITORY_TARGET_LABEL;
  }
}

/**
 * Unambiguous fallback button text when two targets share a display name: the
 * repo's fullName, or the environment name tagged as an environment.
 */
function targetDisambiguatedName(target: SlackSessionTarget): string {
  switch (target.kind) {
    case "repository":
      return target.repo.fullName;
    case "environment":
      return `${target.environment.name} (environment)`;
    case "none":
      return NO_REPOSITORY_TARGET_LABEL;
  }
}

/**
 * One-click buttons for the classifier's ranked alternatives, capped at
 * MAX_TARGET_QUICK_PICKS. Each carries the target's stable value and routes
 * through the same selection handler as the picker.
 */
export function buildTargetQuickPickButtons(
  alternatives: SlackSessionTarget[]
): SlackButtonElement[] {
  const picks = alternatives.slice(0, MAX_TARGET_QUICK_PICKS);
  const ambiguousNames = duplicateDisplayNames(picks);

  return picks.map((target, index) => ({
    type: "button",
    action_id: quickPickActionId(index),
    // Two targets can share a display name (e.g. the same repo name under
    // different owners, or an environment named after a repo); fall back to an
    // unambiguous form for the colliding picks.
    text: plainTextOption(
      ambiguousNames.has(targetDisplayName(target))
        ? targetDisambiguatedName(target)
        : targetDisplayName(target)
    ),
    value: targetValue(target),
  }));
}

/** Display names that appear more than once across the given targets. */
function duplicateDisplayNames(targets: SlackSessionTarget[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const target of targets) {
    const name = targetDisplayName(target);
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }
  return duplicates;
}

/**
 * Blocks for the clarification message: the classifier's reasoning, its ranked
 * alternatives (repositories or environments) as quick-pick buttons (when
 * any), and a searchable picker over every available target as the fallback.
 */
export function buildTargetClarificationBlocks(
  reasoning: string,
  alternatives: SlackSessionTarget[] | undefined,
  catalog: TargetCatalog,
  requestId: string
): Array<SlackSectionBlock | SlackActionsBlock> {
  const quickPicks = alternatives?.length ? buildTargetQuickPickButtons(alternatives) : [];
  const total = catalog.repos.length + catalog.environments.length + 1;
  const usesInlinePicker = total <= MAX_REPO_SUGGESTION_OPTIONS;
  const catalogNotice = getTargetCatalogNotice(catalog);

  const blocks: Array<SlackSectionBlock | SlackActionsBlock> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `I couldn't determine which target to use.\n\n_${reasoning}_${catalogNotice}`,
      },
    },
  ];

  if (quickPicks.length > 0) {
    blocks.push({
      type: "actions",
      block_id: targetQuickPickBlockId(requestId),
      elements: quickPicks,
    });
  }

  blocks.push({
    type: "section",
    block_id: targetPickerBlockId(requestId),
    text: {
      type: "mrkdwn",
      text:
        quickPicks.length > 0
          ? usesInlinePicker
            ? "Or choose another target:"
            : "Or search for another target:"
          : "Which target should I use?",
    },
    accessory: buildTargetPickerAccessory(catalog),
  });

  return blocks;
}

/**
 * The clarification message's text once a target is picked. Slack leaves the
 * picker and quick-pick buttons interactive forever, so a resolved
 * clarification still reads as an open question the user can answer again;
 * collapsing the message to a record of the choice makes the selection final.
 *
 * Passed to `chat.update` as `text` with no `blocks`, which is what drops the
 * picker: Slack removes a message's existing blocks when `text` is supplied
 * without them.
 */
export function targetSelectedText(target: SlackSessionTarget): string {
  return `Using *${escapeMrkdwnText(targetLabel(target))}*`;
}
