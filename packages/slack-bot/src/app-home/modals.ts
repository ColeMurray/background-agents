import { openView } from "@open-inspect/shared";
import {
  BRANCH_INPUT_ACTION_ID,
  BRANCH_INPUT_BLOCK_ID,
  BRANCH_MODAL_CALLBACK_ID,
  REPO_BRANCH_MODAL_CALLBACK_ID,
} from "../branch-preferences";
import { createLogger } from "../logger";
import type { Env, RepoConfig } from "../types";
import { encodeBranchModalMetadata, encodeRepoBranchModalMetadata } from "./metadata";
import type { AppHomeModalBlock } from "./slack-types";
import type { SlackInputBlock } from "../slack-blocks";

const log = createLogger("app-home");

type BranchInputBlockOptions = {
  label: string;
  hint: string;
  currentBranch: string | undefined;
};

function buildBranchInputBlock({
  label,
  hint,
  currentBranch,
}: BranchInputBlockOptions): SlackInputBlock {
  return {
    type: "input",
    block_id: BRANCH_INPUT_BLOCK_ID,
    optional: true,
    label: {
      type: "plain_text",
      text: label,
    },
    element: {
      type: "plain_text_input",
      action_id: BRANCH_INPUT_ACTION_ID,
      initial_value: currentBranch || "",
      placeholder: {
        type: "plain_text",
        text: "e.g. main, staging, release/2026-03",
      },
    },
    hint: {
      type: "plain_text",
      text: hint,
    },
  };
}

export async function openBranchPreferenceModal(
  env: Env,
  userId: string,
  triggerId: string,
  currentBranch?: string
): Promise<void> {
  const blocks: AppHomeModalBlock[] = [
    buildBranchInputBlock({
      label: "Default branch for new Slack sessions",
      hint: "Leave empty to use each repository's default branch.",
      currentBranch,
    }),
  ];

  const result = await openView(env.SLACK_BOT_TOKEN, triggerId, {
    type: "modal",
    callback_id: BRANCH_MODAL_CALLBACK_ID,
    title: {
      type: "plain_text",
      text: "Branch Preference",
    },
    submit: {
      type: "plain_text",
      text: "Save",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    private_metadata: encodeBranchModalMetadata({ userId }),
    blocks,
  });

  if (!result.ok) {
    log.error("slack.open_branch_modal", {
      user_id: userId,
      outcome: "error",
      slack_error: result.error,
    });
  }
}

export async function openRepoBranchPreferenceModal(
  env: Env,
  userId: string,
  triggerId: string,
  repo: RepoConfig,
  currentBranch?: string
): Promise<void> {
  const blocks: AppHomeModalBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Repository: *${repo.fullName}*`,
      },
    },
    buildBranchInputBlock({
      label: "Branch override",
      hint: "Leave empty to clear this repository override.",
      currentBranch,
    }),
  ];

  const result = await openView(env.SLACK_BOT_TOKEN, triggerId, {
    type: "modal",
    callback_id: REPO_BRANCH_MODAL_CALLBACK_ID,
    title: {
      type: "plain_text",
      text: "Repo Branch",
    },
    submit: {
      type: "plain_text",
      text: "Save",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    private_metadata: encodeRepoBranchModalMetadata({ userId, repoId: repo.id }),
    blocks,
  });

  if (!result.ok) {
    log.error("slack.open_repo_branch_modal", {
      user_id: userId,
      repo_id: repo.id,
      outcome: "error",
      slack_error: result.error,
    });
  }
}
