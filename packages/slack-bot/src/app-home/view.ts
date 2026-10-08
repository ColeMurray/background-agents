import {
  HARNESS_IDS,
  getHarnessLabel,
  harnessSupportsModel,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import { getDefaultReasoningEffort, getReasoningConfig } from "@open-inspect/shared/models";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import { CLEAR_REPO_BRANCH_ACTION_ID, REPO_BRANCH_SELECTOR_ACTION_ID } from "../branch-preferences";
import {
  CLEAR_BRANCH_PREFERENCE_ACTION_ID,
  MAX_RENDERED_REPO_OVERRIDES,
  OPEN_BRANCH_MODAL_ACTION_ID,
  SELECT_HARNESS_ACTION_ID,
  SELECT_MODEL_ACTION_ID,
  SELECT_REASONING_EFFORT_ACTION_ID,
  WORKSPACE_HARNESS_OPTION_VALUE,
} from "./constants";
import type { AppHomeBlock, AppHomeView, ModelOption } from "./slack-types";
import type { SlackSelectOption } from "../slack-blocks";
import { plainTextOption } from "../slack-options";

export interface AppHomeViewState {
  appName: string;
  availableModels: ModelOption[];
  /** The harness the user chose; undefined follows the workspace harness. */
  userHarness: HarnessId | undefined;
  workspaceHarness: HarnessId;
  currentModel: string;
  currentEffort: string | undefined;
  currentBranch: string | undefined;
  repos: RepoConfig[];
  repoBranchPreferences: Map<string, string>;
}

type ConfiguredRepoOverride = {
  repo: RepoConfig;
  branch: string;
};

export function buildAppHomeIntroText(appName: string): string {
  return `Configure your ${appName} preferences below.`;
}

export function buildRepoBranchSelectOptions(
  repos: RepoConfig[],
  repoBranchPreferences: Map<string, string>
): SlackSelectOption[] {
  return repos.map((repo) => {
    const repoBranch = repoBranchPreferences.get(repo.id);
    const label = repoBranch ? `${repo.fullName} → ${repoBranch}` : repo.fullName;
    return {
      text: plainTextOption(label),
      value: repo.id,
    };
  });
}

function toSelectOption(model: ModelOption): SlackSelectOption {
  return {
    text: plainTextOption(model.label),
    value: model.value,
  };
}

function buildHarnessBlocks(
  userHarness: HarnessId | undefined,
  workspaceHarness: HarnessId
): AppHomeBlock[] {
  const workspaceOption: SlackSelectOption = {
    text: plainTextOption(`Workspace default (${getHarnessLabel(workspaceHarness)})`),
    value: WORKSPACE_HARNESS_OPTION_VALUE,
  };
  const harnessOptions = HARNESS_IDS.map((harness) => ({
    text: plainTextOption(getHarnessLabel(harness)),
    value: harness,
  }));
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Agent harness*\nChoose the agent that runs your new Slack sessions:",
      },
    },
    {
      type: "actions",
      block_id: "harness_selection",
      elements: [
        {
          type: "static_select",
          action_id: SELECT_HARNESS_ACTION_ID,
          initial_option:
            harnessOptions.find((option) => option.value === userHarness) ?? workspaceOption,
          options: [workspaceOption, ...harnessOptions],
        },
      ],
    },
  ];
}

/**
 * The model picker lists only models the harness can run. A current model it
 * cannot run is left unselected with a warning, because launches refuse it.
 */
function buildModelBlocks(
  harness: HarnessId,
  currentModel: string,
  currentModelInfo: ModelOption | undefined,
  modelOptions: ModelOption[]
): AppHomeBlock[] {
  const harnessLabel = getHarnessLabel(harness);
  if (modelOptions.length === 0) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Model*\nNo enabled model can run on ${harnessLabel}. Choose another agent harness, or ask an admin to enable a model it can run.`,
        },
      },
    ];
  }
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Model*\nSelect the model for your coding sessions:",
      },
    },
    {
      type: "actions",
      block_id: "model_selection",
      elements: [
        {
          type: "static_select",
          action_id: SELECT_MODEL_ACTION_ID,
          ...(currentModelInfo
            ? { initial_option: toSelectOption(currentModelInfo) }
            : { placeholder: { type: "plain_text" as const, text: "Choose a model" } }),
          options: modelOptions.map(toSelectOption),
        },
      ],
    },
    ...(currentModelInfo
      ? []
      : [
          {
            type: "context" as const,
            elements: [
              {
                type: "mrkdwn" as const,
                text: `Your model \`${currentModel}\` can't run on ${harnessLabel}, so new requests are refused until you choose a model above.`,
              },
            ],
          },
        ]),
  ];
}

function buildReasoningBlocks(
  currentModel: string,
  effectiveEffort: string | undefined
): AppHomeBlock[] {
  const reasoningConfig = getReasoningConfig(currentModel);
  if (!reasoningConfig) {
    return [];
  }

  const reasoningOptions = reasoningConfig.efforts.map((effort) => ({
    text: { type: "plain_text" as const, text: effort },
    value: effort,
  }));
  const currentEffortOption = reasoningOptions.find((option) => option.value === effectiveEffort);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Reasoning Effort*\nControl the depth of reasoning for your sessions:",
      },
    },
    {
      type: "actions",
      block_id: "reasoning_selection",
      elements: [
        {
          type: "static_select",
          action_id: SELECT_REASONING_EFFORT_ACTION_ID,
          ...(currentEffortOption ? { initial_option: currentEffortOption } : {}),
          placeholder: { type: "plain_text" as const, text: "Select effort" },
          options: reasoningOptions,
        },
      ],
    },
  ];
}

function buildGlobalBranchBlocks(currentBranch: string | undefined): AppHomeBlock[] {
  return [
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Branch (optional)*\nSet a default branch for new Slack sessions. Leave empty to use each repository default branch.",
      },
      accessory: {
        type: "button",
        action_id: OPEN_BRANCH_MODAL_ACTION_ID,
        text: { type: "plain_text", text: currentBranch ? "Edit branch" : "Set branch" },
        value: OPEN_BRANCH_MODAL_ACTION_ID,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: currentBranch
            ? `Branch override: *${currentBranch}*`
            : "Branch override: *(repo default)*",
        },
      ],
    },
    ...(currentBranch
      ? [
          {
            type: "actions" as const,
            elements: [
              {
                type: "button" as const,
                action_id: CLEAR_BRANCH_PREFERENCE_ACTION_ID,
                text: { type: "plain_text" as const, text: "Clear branch override" },
                style: "danger" as const,
                value: CLEAR_BRANCH_PREFERENCE_ACTION_ID,
              },
            ],
          },
        ]
      : []),
  ];
}

function getConfiguredRepoOverrides(
  repos: RepoConfig[],
  repoBranchPreferences: Map<string, string>
): ConfiguredRepoOverride[] {
  return repos
    .map((repo) => ({ repo, branch: repoBranchPreferences.get(repo.id) }))
    .filter((entry): entry is ConfiguredRepoOverride => Boolean(entry.branch));
}

function buildRepoOverrideRow({ repo, branch }: ConfiguredRepoOverride): AppHomeBlock {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `\`${repo.fullName}\` → *${branch}*`,
    },
    accessory: {
      type: "button",
      action_id: CLEAR_REPO_BRANCH_ACTION_ID,
      text: { type: "plain_text", text: "Delete" },
      style: "danger",
      value: repo.id,
      confirm: {
        title: { type: "plain_text", text: "Delete override?" },
        text: {
          type: "mrkdwn",
          text: `Remove branch override for *${repo.fullName}*?`,
        },
        confirm: { type: "plain_text", text: "Delete" },
        deny: { type: "plain_text", text: "Cancel" },
      },
    },
  };
}

function buildConfiguredRepoOverrideBlocks(
  configuredRepoOverrides: ConfiguredRepoOverride[]
): AppHomeBlock[] {
  if (configuredRepoOverrides.length === 0) {
    return [];
  }

  const renderedOverrides = configuredRepoOverrides.slice(0, MAX_RENDERED_REPO_OVERRIDES);
  const hiddenOverrideCount = configuredRepoOverrides.length - renderedOverrides.length;

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Configured repo overrides*",
      },
    },
    ...renderedOverrides.map(buildRepoOverrideRow),
    ...(hiddenOverrideCount > 0
      ? [
          {
            type: "context" as const,
            elements: [
              {
                type: "mrkdwn" as const,
                text: `…and ${hiddenOverrideCount} more override${hiddenOverrideCount === 1 ? "" : "s"}. Use *Search repository* above to view or clear any repo's override.`,
              },
            ],
          },
        ]
      : []),
  ];
}

function buildRepoBranchBlocks(
  repos: RepoConfig[],
  repoBranchPreferences: Map<string, string>
): AppHomeBlock[] {
  if (repos.length === 0) {
    return [];
  }

  const configuredRepoOverrides = getConfiguredRepoOverrides(repos, repoBranchPreferences);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Branch by repository*\nChoose a repository to set a repo-specific branch override.",
      },
    },
    {
      type: "actions",
      block_id: "repo_branch_selection",
      elements: [
        {
          type: "external_select",
          action_id: REPO_BRANCH_SELECTOR_ACTION_ID,
          placeholder: { type: "plain_text", text: "Search repository" },
          min_query_length: 0,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Priority: repo-specific override → global override → repository default branch.",
        },
      ],
    },
    ...buildConfiguredRepoOverrideBlocks(configuredRepoOverrides),
  ];
}

function buildSummaryBlock(
  harness: HarnessId,
  currentModelInfo: ModelOption | undefined,
  effectiveEffort: string | undefined,
  currentBranch: string | undefined
): AppHomeBlock {
  const parts = [
    currentModelInfo ? `*${currentModelInfo.label}*` : "*no model it can run*",
    ...(currentModelInfo && effectiveEffort ? [effectiveEffort] : []),
    ...(currentBranch ? [`branch:${currentBranch}`] : []),
    getHarnessLabel(harness),
  ];
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: `Currently using: ${parts.join(" · ")}` }],
  };
}

export function buildAppHomeView({
  appName,
  availableModels,
  userHarness,
  workspaceHarness,
  currentModel,
  currentEffort,
  currentBranch,
  repos,
  repoBranchPreferences,
}: AppHomeViewState): AppHomeView {
  const harness = userHarness ?? workspaceHarness;
  const modelOptions = availableModels.filter((model) =>
    harnessSupportsModel(harness, model.value)
  );
  const currentModelInfo = harnessSupportsModel(harness, currentModel)
    ? (modelOptions.find((model) => model.value === currentModel) ??
      modelOptions[0] ?? { label: currentModel, value: currentModel })
    : undefined;
  const effectiveEffort = currentEffort ?? getDefaultReasoningEffort(currentModel);

  return {
    type: "home",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Settings" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: buildAppHomeIntroText(appName),
        },
      },
      { type: "divider" },
      ...buildHarnessBlocks(userHarness, workspaceHarness),
      ...buildModelBlocks(harness, currentModel, currentModelInfo, modelOptions),
      ...(currentModelInfo ? buildReasoningBlocks(currentModel, effectiveEffort) : []),
      ...buildGlobalBranchBlocks(currentBranch),
      ...buildRepoBranchBlocks(repos, repoBranchPreferences),
      buildSummaryBlock(harness, currentModelInfo, effectiveEffort, currentBranch),
    ],
  };
}
