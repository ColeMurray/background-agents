/**
 * Adaptive Card for session started notification.
 */

export function buildSessionStartedCard(
  repoFullName: string,
  reasoning: string,
  sessionId: string,
  webAppUrl: string
): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: `Working on **${repoFullName}**...`,
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
        text: "The agent is now working on your request.",
        wrap: true,
      },
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: "View Session",
        url: `${webAppUrl}/session/${sessionId}`,
      },
    ],
  };
}
