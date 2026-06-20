/**
 * Repo clarification picker UI.
 *
 * When the classifier can't decide which repository a Slack message refers to,
 * the bot posts a clarification message: the classifier's ranked guesses as
 * one-click quick-pick buttons, plus a searchable external_select over every
 * repo. This module owns that UI — the options Slack queries as the user types,
 * the quick-pick buttons, and the message blocks themselves.
 */

import { getAvailableRepos, filterReposByQuery } from "./classifier/repos";
import { MAX_REPO_SUGGESTION_OPTIONS } from "./app-home/constants";
import { plainTextOption } from "./slack-options";
import type {
  SlackActionsBlock,
  SlackButtonElement,
  SlackSectionBlock,
  SlackSelectOption,
} from "./app-home/slack-types";
import type { Env, RepoConfig } from "./types";

/**
 * Action ID for the repository picker shown when the classifier can't decide
 * which repo a message refers to. The picker is an external_select, so the same
 * ID is matched both for option suggestions (block_suggestion) and selection
 * (block_actions).
 */
export const SELECT_REPO_ACTION_ID = "select_repo";

/**
 * Action ID for the one-click quick-pick buttons that surface the classifier's
 * ranked alternatives. Routed through the same selection path as the picker.
 */
export const SELECT_REPO_QUICK_PICK_ACTION_ID = "select_repo_quick_pick";

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

/**
 * One-click buttons for the classifier's ranked alternatives, capped at
 * MAX_REPO_QUICK_PICKS. Each carries the repo id and routes through the same
 * selection handler as the picker.
 */
export function buildRepoQuickPickButtons(alternatives: RepoConfig[]): SlackButtonElement[] {
  const picks = alternatives.slice(0, MAX_REPO_QUICK_PICKS);
  const ambiguousNames = duplicateDisplayNames(picks);

  return picks.map((repo) => ({
    type: "button",
    action_id: SELECT_REPO_QUICK_PICK_ACTION_ID,
    // Two repos can share a displayName (e.g. the same repo name under different
    // owners); fall back to the unambiguous fullName for the colliding picks.
    text: plainTextOption(ambiguousNames.has(repo.displayName) ? repo.fullName : repo.displayName),
    value: repo.id,
  }));
}

/** Display names that appear more than once across the given repos. */
function duplicateDisplayNames(repos: RepoConfig[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const repo of repos) {
    if (seen.has(repo.displayName)) {
      duplicates.add(repo.displayName);
    }
    seen.add(repo.displayName);
  }
  return duplicates;
}

/**
 * Blocks for the clarification message: the classifier's reasoning, its ranked
 * alternatives as quick-pick buttons (when any), and a searchable picker over
 * every repo as the fallback.
 */
export function buildRepoClarificationBlocks(
  reasoning: string,
  alternatives: RepoConfig[] | undefined
): Array<SlackSectionBlock | SlackActionsBlock> {
  const quickPicks = alternatives?.length ? buildRepoQuickPickButtons(alternatives) : [];

  const blocks: Array<SlackSectionBlock | SlackActionsBlock> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `I couldn't determine which repository you're referring to.\n\n_${reasoning}_`,
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
          ? "Or search for another repository:"
          : "Which repository should I work with?",
    },
    accessory: {
      type: "external_select",
      placeholder: { type: "plain_text", text: "Select a repository" },
      // 0 so the list appears on open; typing filters across all repos.
      min_query_length: 0,
      action_id: SELECT_REPO_ACTION_ID,
    },
  });

  return blocks;
}
