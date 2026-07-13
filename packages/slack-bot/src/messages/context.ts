export function formatThreadContext(previousMessages: string[]): string {
  if (previousMessages.length === 0) return "";
  return `Context from the Slack thread:\n---\n${previousMessages.join("\n")}\n---\n\n`;
}

export function formatInterimThreadContext(interimMessages: string[]): string {
  if (interimMessages.length === 0) return "";
  return `New messages in the Slack thread since your last task:\n---\n${interimMessages.join("\n")}\n---\n\n`;
}

export function formatChannelContext(channelName: string, channelDescription?: string): string {
  let context = `Slack channel context:\n---\nChannel: #${channelName}`;
  if (channelDescription) context += `\nDescription: ${channelDescription}`;
  return `${context}\n---\n\n`;
}
