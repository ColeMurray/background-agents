export const PROMPT_SUBMISSION_UPGRADE_MESSAGE =
  "Prompt submission requires a newer server version.";

export function getPromptSubmissionDisabledMessage(
  ready: boolean,
  canSubmitPrompt: boolean
): string | null {
  return ready && !canSubmitPrompt ? PROMPT_SUBMISSION_UPGRADE_MESSAGE : null;
}
