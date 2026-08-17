export function restoreQueuedPrompt({
  content,
  currentPrompt,
  hasAttachments,
  setPrompt,
  input,
}: {
  content: string;
  currentPrompt: string;
  hasAttachments: boolean;
  setPrompt: (prompt: string) => void;
  input: HTMLTextAreaElement | null;
}): boolean {
  if (currentPrompt.trim().length > 0 || hasAttachments) return false;
  setPrompt(content);
  input?.focus();
  return true;
}
