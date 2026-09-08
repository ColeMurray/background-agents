export const MAX_REPO_SUGGESTION_OPTIONS = 100;

// Max repo-specific branch overrides rendered in the App Home tab. Each renders
// one block and Slack's views.publish rejects views over 100 blocks, so this
// bounds the list well under the limit (the base App Home uses ~15 blocks).
export const MAX_RENDERED_REPO_OVERRIDES = 50;

export const SELECT_MODEL_ACTION_ID = "select_model";
export const SELECT_REASONING_EFFORT_ACTION_ID = "select_reasoning_effort";
export const OPEN_BRANCH_MODAL_ACTION_ID = "open_branch_modal";
export const CLEAR_BRANCH_PREFERENCE_ACTION_ID = "clear_branch_preference";
