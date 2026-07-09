/**
 * Repo clarification picker UI.
 *
 * When the classifier can't decide which repository a Slack message refers to,
 * the bot posts a clarification message: the classifier's ranked guesses as
 * one-click quick-pick buttons, plus a repository picker. This module owns that
 * UI — the options Slack queries as the user types, the quick-pick buttons, and
 * the message blocks themselves.
 */

import { getAvailableRepos, filterReposByQuery } from "./classifier/repos";
import { MAX_REPO_SUGGESTION_OPTIONS } from "./app-home/constants";
import { plainTextOption } from "./slack-options";
import { targetValue, type SlackSessionTarget } from "./targets";
import type {
  SlackActionsBlock,
  SlackButtonElement,
  SlackExternalSelectElement,
  SlackSectionBlock,
  SlackSelectOption,
  SlackStaticSelectElement,
} from "./slack-blocks";
import type { Env, RepoConfig } from "./types";

/**
 * Action ID for the repository picker shown when the classifier can't decide
 * which repo a message refers to. The picker is an external_select, so the same
 * ID is matched both for option suggestions (block_suggestion) and selection
 * (block_actions).
 */
export const SELECT_REPO_ACTION_ID = "select_repo";

/**
 * Action ID prefix for the one-click quick-pick buttons that surface the
 * classifier's ranked alternatives. Routed through the same selection path as
 * the picker; each button gets a unique suffix via {@link quickPickActionId}.
 */
export const SELECT_REPO_QUICK_PICK_ACTION_ID = "select_repo_quick_pick";

/** Unique per-button action_id; Slack requires action_id uniqueness within an actions block. */
export function quickPickActionId(index: number): string {
  return `${SELECT_REPO_QUICK_PICK_ACTION_ID}:${index}`;
}

/**
 * Collapse a quick-pick's per-button action_id back to the bare constant so the
 * interactions handler can match it; other action_ids pass through unchanged.
 */
export function baseActionId(actionId: string): string {
  return actionId.startsWith(`${SELECT_REPO_QUICK_PICK_ACTION_ID}:`)
    ? SELECT_REPO_QUICK_PICK_ACTION_ID
    : actionId;
}

/**
 * Cap on quick-pick buttons in the clarification message. The classifier rarely
 * returns more, and the actions block shouldn't become a wall of buttons — the
 * searchable picker covers everything beyond the top guesses.
 */
export const MAX_REPO_QUICK_PICKS = 5;

function toRepoSelectOption(repo: RepoConfig): SlackSelectOption {
  return {
    text: plainTextOption(repo.displayName),
    description: plainTextOption(repo.description),
    value: repo.id,
  };
}

/**
 * Options for the clarification picker's external_select. Slack queries this as
 * the user types; we filter on the repo's full name and cap at Slack's
 * per-response limit. With min_query_length 0 the unfiltered list shows as soon
 * as the menu opens, and typing surfaces any of the remaining repos.
 */
export async function getRepoClarificationOptions(
  env: Env,
  query: string | undefined,
  traceId?: string
): Promise<SlackSelectOption[]> {
  const repos = filterReposByQuery(await getAvailableRepos(env, traceId), query);
  return repos.slice(0, MAX_REPO_SUGGESTION_OPTIONS).map(toRepoSelectOption);
}

function buildRepoPickerAccessory(
  repos: RepoConfig[]
): SlackStaticSelectElement | SlackExternalSelectElement {
  if (repos.length > 0 && repos.length <= MAX_REPO_SUGGESTION_OPTIONS) {
    return {
      type: "static_select",
      placeholder: { type: "plain_text", text: "Select a repository" },
      options: repos.map(toRepoSelectOption),
      action_id: SELECT_REPO_ACTION_ID,
    };
  }

  return {
    type: "external_select",
    placeholder: { type: "plain_text", text: "Select a repository" },
    // 0 so the list appears on open; typing filters across all repos.
    min_query_length: 0,
    action_id: SELECT_REPO_ACTION_ID,
  };
}

/** Short button text for a target: the repo displayName or environment name. */
function targetDisplayName(target: SlackSessionTarget): string {
  return target.kind === "environment" ? target.environment.name : target.repo.displayName;
}

/**
 * Unambiguous fallback button text when two targets share a display name: the
 * repo's fullName, or the environment name tagged as an environment.
 */
function targetDisambiguatedName(target: SlackSessionTarget): string {
  return target.kind === "environment"
    ? `${target.environment.name} (environment)`
    : target.repo.fullName;
}

/**
 * One-click buttons for the classifier's ranked alternatives — repositories or
 * environments — capped at MAX_REPO_QUICK_PICKS. Each carries the target's
 * value (repo id or `env:<id>`) and routes through the same selection handler
 * as the picker.
 */
export function buildTargetQuickPickButtons(
  alternatives: SlackSessionTarget[]
): SlackButtonElement[] {
  const picks = alternatives.slice(0, MAX_REPO_QUICK_PICKS);
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
 * any), and a searchable picker over every repo as the fallback.
 */
export function buildRepoClarificationBlocks(
  reasoning: string,
  alternatives: SlackSessionTarget[] | undefined,
  repos: RepoConfig[]
): Array<SlackSectionBlock | SlackActionsBlock> {
  const quickPicks = alternatives?.length ? buildTargetQuickPickButtons(alternatives) : [];
  const usesInlinePicker = repos.length > 0 && repos.length <= MAX_REPO_SUGGESTION_OPTIONS;
  // The headline names environments only when one is actually on offer; the
  // fallback picker below stays repository-only either way.
  const subject = alternatives?.some((target) => target.kind === "environment")
    ? "which repository or environment"
    : "which repository";

  const blocks: Array<SlackSectionBlock | SlackActionsBlock> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `I couldn't determine ${subject} you're referring to.\n\n_${reasoning}_`,
      },
    },
  ];

  if (quickPicks.length > 0) {
    blocks.push({ type: "actions", block_id: "repo_quick_picks", elements: quickPicks });
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        quickPicks.length > 0
          ? usesInlinePicker
            ? "Or choose another repository:"
            : "Or search for another repository:"
          : "Which repository should I work with?",
    },
    accessory: buildRepoPickerAccessory(repos),
  });

  return blocks;
}
