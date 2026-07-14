function formatMessageSection(header: string, messages: string[]): string {
  if (messages.length === 0) return "";
  return `${header}:\n---\n${messages.join("\n")}\n---\n\n`;
}

export function formatThreadContext(previousMessages: string[]): string {
  return formatMessageSection("Context from the Slack thread", previousMessages);
}

export function formatInterimThreadContext(interimMessages: string[]): string {
  return formatMessageSection(
    "New messages in the Slack thread since your last task",
    interimMessages
  );
}

export function formatChannelContext(channelName: string, channelDescription?: string): string {
  let context = `Slack channel context:\n---\nChannel: #${channelName}`;
  if (channelDescription) context += `\nDescription: ${channelDescription}`;
  return `${context}\n---\n\n`;
}
