export const SHORTCUT_LABELS = {
  SEND_PROMPT: "Cmd/Ctrl+Enter",
  COMMAND_MENU: "Cmd/Ctrl+K",
  NEW_SESSION: "Cmd/Ctrl+Shift+O",
  TOGGLE_SIDEBAR: "Cmd/Ctrl+/",
} as const;

export type GlobalShortcutAction = "open-command-menu" | "new-session" | "toggle-sidebar";

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

export function shouldIgnoreGlobalShortcutForAction(
  event: KeyboardEvent,
  action: GlobalShortcutAction
) {
  if (event.defaultPrevented || event.isComposing) return true;
  if (action === "open-command-menu") return false;
  return isEditableElement(event.target);
}

export function matchGlobalShortcut(event: KeyboardEvent): GlobalShortcutAction | null {
  if (!hasPrimaryModifier(event) || event.altKey) return null;

  const key = event.key.toLowerCase();
  if (key === "k" && !event.shiftKey) {
    return "open-command-menu";
  }

  if (key === "o" && event.shiftKey) {
    return "new-session";
  }

  if (event.code === "Slash" && !event.shiftKey) {
    return "toggle-sidebar";
  }

  return null;
}
