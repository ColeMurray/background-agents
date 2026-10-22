/**
 * The slash command this bot registers and handles. One definition serves both
 * `scripts/register-commands.ts` and the interaction handler, so the names
 * Discord sends are the names the handler reads.
 */

/** Discord application command option type for a string option. */
const STRING_OPTION = 3;

export const TASK_COMMAND_NAME = "task";
export const PROMPT_OPTION_NAME = "prompt";
export const REPO_OPTION_NAME = "repo";

/** The `/task` command as Discord's application-command API expects it. */
export const TASK_COMMAND = {
  name: TASK_COMMAND_NAME,
  description: "Give the coding agent a task",
  options: [
    {
      type: STRING_OPTION,
      name: PROMPT_OPTION_NAME,
      description: "What should the agent do?",
      required: true,
      max_length: 4000,
    },
    {
      type: STRING_OPTION,
      name: REPO_OPTION_NAME,
      description: "Repository to work on (not needed inside a task thread)",
      required: false,
      autocomplete: true,
    },
  ],
} as const;
