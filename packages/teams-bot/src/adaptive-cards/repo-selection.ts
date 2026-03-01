/**
 * Adaptive Card for repository selection when classification is uncertain.
 */

export function buildRepoSelectionCard(
  repos: Array<{ id: string; displayName: string; description: string }>,
  reasoning: string
): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "I couldn't determine which repository you're referring to.",
        wrap: true,
        weight: "Bolder",
      },
      {
        type: "TextBlock",
        text: reasoning,
        wrap: true,
        isSubtle: true,
        size: "Small",
      },
      {
        type: "TextBlock",
        text: "Which repository should I work with?",
        wrap: true,
      },
      {
        type: "Input.ChoiceSet",
        id: "repoId",
        style: "compact",
        value: repos[0]?.id ?? "",
        choices: repos.map((r) => ({
          title: `${r.displayName} — ${r.description.slice(0, 60)}`,
          value: r.id,
        })),
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Select Repository",
        data: { action: "select_repo" },
      },
    ],
  };
}
