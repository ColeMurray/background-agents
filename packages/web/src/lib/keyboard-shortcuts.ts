import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  GLOBAL_KEYBOARD_SHORTCUT_ACTIONS,
  KEYBOARD_SHORTCUT_ACTIONS,
  isKeyboardShortcutBindingAllowed,
  keyboardShortcutBindingKey,
  keyboardShortcutBindingSchema,
  type KeyboardShortcutAction,
  type KeyboardShortcutBinding,
  type KeyboardShortcutPreferences,
  type GlobalKeyboardShortcutAction,
} from "@open-inspect/shared/types/keyboard-shortcuts";

export type GlobalShortcutAction = GlobalKeyboardShortcutAction;

const CODE_LABELS: Record<string, string> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: "Space",
};

export function matchesShortcut(event: KeyboardEvent, binding: KeyboardShortcutBinding): boolean {
  return (
    event.code === binding.code &&
    (event.metaKey || event.ctrlKey) === binding.primary &&
    event.altKey === binding.alt &&
    event.shiftKey === binding.shift
  );
}

export function captureShortcut(
  event: KeyboardEvent,
  action: KeyboardShortcutAction
): KeyboardShortcutBinding | null {
  const binding = {
    code: event.code,
    primary: event.metaKey || event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
  const parsed = keyboardShortcutBindingSchema.safeParse(binding);
  return parsed.success && isKeyboardShortcutBindingAllowed(action, parsed.data)
    ? parsed.data
    : null;
}

export function formatShortcut(binding: KeyboardShortcutBinding): string {
  const modifiers = [
    binding.primary ? "Cmd/Ctrl" : null,
    binding.alt ? "Alt" : null,
    binding.shift ? "Shift" : null,
  ].filter(Boolean);
  return [...modifiers, formatCode(binding.code)].join("+");
}

function formatCode(code: string): string {
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Numpad ${code.slice(6)}`;
  return code;
}

export function findDuplicateShortcutActions(
  shortcuts: KeyboardShortcutPreferences
): Set<KeyboardShortcutAction> {
  const actionsByBinding = new Map<string, KeyboardShortcutAction[]>();
  for (const action of KEYBOARD_SHORTCUT_ACTIONS) {
    const binding = shortcuts[action];
    const canonical = keyboardShortcutBindingKey(binding);
    const actions = actionsByBinding.get(canonical) ?? [];
    actions.push(action);
    actionsByBinding.set(canonical, actions);
  }
  return new Set([...actionsByBinding.values()].filter((actions) => actions.length > 1).flat());
}

export function matchGlobalShortcut(
  event: KeyboardEvent,
  shortcuts: KeyboardShortcutPreferences = DEFAULT_KEYBOARD_SHORTCUTS
): GlobalShortcutAction | null {
  return (
    GLOBAL_KEYBOARD_SHORTCUT_ACTIONS.find((action) => matchesShortcut(event, shortcuts[action])) ??
    null
  );
}

function isEditableElement(target: EventTarget | null) {
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
