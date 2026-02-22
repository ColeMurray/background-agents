import type { ComposerCommand } from "./composer-commands";

export type ComposerAutocompleteState = "closed" | "loading" | "open" | "empty" | "error";

const MAX_RESULTS = 8;

function commandMatchesQuery(command: ComposerCommand, query: string): boolean {
  const normalizedQuery = query.toLowerCase();
  if (!normalizedQuery) return true;

  const fields = [command.command, command.title, command.description].map((value) =>
    value.toLowerCase()
  );
  return fields.some((value) => value.includes(normalizedQuery));
}

function commandRank(command: ComposerCommand, query: string): number {
  if (!query) return 0;
  const normalizedQuery = query.toLowerCase();

  if (command.command.toLowerCase().startsWith(normalizedQuery)) return 0;
  if (command.title.toLowerCase().startsWith(normalizedQuery)) return 1;
  return 2;
}

export function filterComposerCommands(
  commands: ComposerCommand[],
  query: string
): ComposerCommand[] {
  return commands
    .slice()
    .filter((command) => commandMatchesQuery(command, query))
    .sort((a, b) => commandRank(a, query) - commandRank(b, query))
    .slice(0, MAX_RESULTS);
}

export function nextAutocompleteRequestVersion(currentVersion: number): number {
  return currentVersion + 1;
}

export function isLatestAutocompleteResult(
  responseVersion: number,
  latestRequestVersion: number
): boolean {
  return responseVersion === latestRequestVersion;
}
