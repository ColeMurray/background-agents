/**
 * Adaptive Card for model and settings selection.
 */

export function buildModelSelectionCard(
  currentModel: string,
  currentEffort: string | undefined,
  availableModels: Array<{ label: string; value: string }>,
  reasoningEfforts?: string[]
): Record<string, unknown> {
  const body: unknown[] = [
    {
      type: "TextBlock",
      text: "Open-Inspect Settings",
      weight: "Bolder",
      size: "Medium",
    },
    {
      type: "TextBlock",
      text: "Configure your coding session preferences.",
      wrap: true,
      isSubtle: true,
    },
    {
      type: "TextBlock",
      text: "Model",
      weight: "Bolder",
    },
    {
      type: "Input.ChoiceSet",
      id: "model",
      value: currentModel,
      style: "compact",
      choices: availableModels.map((m) => ({
        title: m.label,
        value: m.value,
      })),
    },
  ];

  if (reasoningEfforts && reasoningEfforts.length > 0) {
    body.push(
      {
        type: "TextBlock",
        text: "Reasoning Effort",
        weight: "Bolder",
      },
      {
        type: "Input.ChoiceSet",
        id: "reasoningEffort",
        value: currentEffort || "",
        style: "compact",
        choices: reasoningEfforts.map((e) => ({
          title: e,
          value: e,
        })),
      }
    );
  }

  body.push({
    type: "TextBlock",
    text: `Currently using: **${currentModel}**${currentEffort ? ` / ${currentEffort}` : ""}`,
    wrap: true,
    isSubtle: true,
    size: "Small",
    separator: true,
  });

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
    actions: [
      {
        type: "Action.Submit",
        title: "Save Preferences",
        data: { action: "save_preferences" },
      },
    ],
  };
}
