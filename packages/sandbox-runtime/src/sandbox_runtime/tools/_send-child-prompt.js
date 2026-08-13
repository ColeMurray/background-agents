import { bridgeFetch, extractError } from "./_bridge-client.js";

export async function executeSendChildPrompt(args) {
  try {
    const encodedChildId = encodeURIComponent(args.childId);
    const response = await bridgeFetch(`/children/${encodedChildId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ content: args.prompt }),
    });

    if (!response.ok) {
      const errorMessage = await extractError(response);
      if (response.status === 404) {
        return `Child "${args.childId}" not found. Use get-child-status to list direct children.`;
      }
      if (response.status === 409) {
        return `Cannot prompt child "${args.childId}": ${errorMessage}`;
      }
      if (response.status === 429) {
        return `Cannot queue another prompt for child "${args.childId}": ${errorMessage}`;
      }
      return `Failed to prompt child: ${errorMessage} (HTTP ${response.status})`;
    }

    const result = await response.json();
    return [
      `Follow-up durably queued for child "${args.childId}".`,
      `Message ID: ${result.messageId}`,
      "The prompt will run after any current child work. Use get-child-status when you need the result.",
    ].join("\n");
  } catch (error) {
    return `Failed to prompt child: ${error instanceof Error ? error.message : String(error)}`;
  }
}
