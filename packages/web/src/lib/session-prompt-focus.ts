export function restorePromptFocusIfUnclaimed(input: HTMLTextAreaElement | null): void {
  if (!input || document.activeElement !== document.body) return;
  input.focus();
}
