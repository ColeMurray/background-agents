export const SHORTCUT_LABELS = {
  SEND_PROMPT: "Cmd/Ctrl+Enter",
  NEW_SESSION: "Cmd/Ctrl+K",
  TOGGLE_SIDEBAR: "Cmd/Ctrl+/",
} as const;

export type GlobalShortcutAction = "new-session" | "toggle-sidebar";

function hasPrimaryModifier(event: KeyboardEvent) {
  return event.metaKey || event.ctrlKey;
}

export function isEditableElement(target: EventTarget | null) {
  const HTMLElementCtor = typeof HTMLElement === "undefined" ? null : HTMLElement;
  if (!HTMLElementCtor || !(target instanceof HTMLElementCtor)) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

export function shouldIgnoreGlobalShortcut(event: KeyboardEvent) {
  return event.defaultPrevented || event.isComposing || isEditableElement(event.target);
}

export function matchGlobalShortcut(event: KeyboardEvent): GlobalShortcutAction | null {
  if (!hasPrimaryModifier(event) || event.altKey) return null;

  const key = event.key.toLowerCase();
  if (key === "k" && !event.shiftKey) {
    return "new-session";
  }

  if (event.code === "Slash" && !event.shiftKey) {
    return "toggle-sidebar";
  }

  return null;
}
