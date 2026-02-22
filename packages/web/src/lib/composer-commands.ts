export interface ComposerCommand {
  id: string;
  command: string;
  title: string;
  description: string;
  template: string;
  starterTitle?: string;
  starterDescription?: string;
}

export const COMPOSER_COMMANDS: ComposerCommand[] = [
  {
    id: "plan",
    command: "plan",
    title: "Plan implementation",
    description: "Scope the change with acceptance criteria before coding",
    template:
      "Create a concise implementation plan for this request. Include scope, acceptance criteria, risks, and tests.",
    starterTitle: "Plan Change",
    starterDescription: "Start with scope, risks, and test plan.",
  },
  {
    id: "build",
    command: "build",
    title: "Implement now",
    description: "Implement the request using existing project patterns",
    template:
      "Implement this request end-to-end. Follow repository conventions, keep changes minimal, and run relevant tests before finalizing.",
    starterTitle: "Implement",
    starterDescription: "Ship the change with minimal, tested edits.",
  },
  {
    id: "review",
    command: "review",
    title: "Technical review",
    description: "Review current work for regressions, risks, and missing tests",
    template:
      "Review these changes and list findings by severity with concrete fixes, risks, and missing tests.",
    starterTitle: "Review Changes",
    starterDescription: "Identify regressions, risks, and test gaps.",
  },
  {
    id: "debug",
    command: "debug",
    title: "Debug issue",
    description: "Reproduce and isolate a bug before applying a fix",
    template:
      "Debug this issue step-by-step: reproduce it, identify root cause, implement the smallest safe fix, and validate with tests.",
    starterTitle: "Debug Issue",
    starterDescription: "Reproduce, isolate root cause, and fix safely.",
  },
  {
    id: "test",
    command: "test",
    title: "Add or improve tests",
    description: "Cover behavior with focused tests and edge cases",
    template:
      "Add or update targeted tests for this behavior, including edge cases and failure modes. Keep tests clear and deterministic.",
  },
  {
    id: "refactor",
    command: "refactor",
    title: "Refactor safely",
    description: "Improve structure without changing behavior",
    template:
      "Refactor this code for clarity and maintainability without changing behavior. Keep diff small and verify with tests.",
  },
  {
    id: "explain",
    command: "explain",
    title: "Explain code",
    description: "Describe how the implementation works and key trade-offs",
    template:
      "Explain how this part of the code works, including data flow, assumptions, and trade-offs.",
  },
];

export function getStarterComposerCommands(
  commands: ComposerCommand[] = COMPOSER_COMMANDS
): ComposerCommand[] {
  return commands.filter((command) => command.starterTitle && command.starterDescription);
}
