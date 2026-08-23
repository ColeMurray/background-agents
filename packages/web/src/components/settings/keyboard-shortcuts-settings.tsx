"use client";

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { toast } from "sonner";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_ACTIONS,
  type KeyboardShortcutAction,
  type KeyboardShortcutPreferences,
} from "@open-inspect/shared/types/keyboard-shortcuts";
import { Button } from "@/components/ui/button";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import {
  captureShortcut,
  findDuplicateShortcutActions,
  formatShortcut,
} from "@/lib/keyboard-shortcuts";
import { cn } from "@/lib/utils";

const SHORTCUT_METADATA = {
  "send-prompt": { label: "Send prompt", description: "Send from a prompt composer" },
  "open-command-menu": { label: "Command menu", description: "Search and navigate" },
  "new-session": { label: "New session", description: "Start a new coding session" },
  "toggle-sidebar": { label: "Toggle sidebar", description: "Show or hide the sidebar" },
} satisfies Record<
  KeyboardShortcutAction,
  {
    label: string;
    description: string;
  }
>;

function shortcutsEqual(a: KeyboardShortcutPreferences, b: KeyboardShortcutPreferences): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function KeyboardShortcutsSettings() {
  const { shortcuts, loading, error, save } = useKeyboardShortcuts();
  const [draft, setDraft] = useState(shortcuts);
  const [saved, setSaved] = useState(shortcuts);
  const [recording, setRecording] = useState<KeyboardShortcutAction | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading && shortcutsEqual(draft, saved) && !shortcutsEqual(saved, shortcuts)) {
      setDraft(shortcuts);
      setSaved(shortcuts);
    }
  }, [draft, loading, saved, shortcuts]);

  const duplicates = findDuplicateShortcutActions(draft);
  const dirty = !shortcutsEqual(draft, saved);
  const isDefault = shortcutsEqual(draft, DEFAULT_KEYBOARD_SHORTCUTS);

  function handleKeyDown(
    action: KeyboardShortcutAction,
    event: ReactKeyboardEvent<HTMLButtonElement>
  ) {
    if (recording !== action) return;
    if (
      event.key === "Escape" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      setRecording(null);
      return;
    }
    const binding = captureShortcut(event.nativeEvent, action);
    if (!binding) return;
    event.preventDefault();
    event.stopPropagation();
    setDraft((current) => ({ ...current, [action]: binding }));
    setRecording(null);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await save(draft);
      setSaved(draft);
      toast.success("Keyboard shortcuts saved.");
    } catch (saveError) {
      toast.error(
        saveError instanceof Error ? saveError.message : "Failed to save keyboard shortcuts"
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading keyboard shortcuts...</p>;
  }

  const sendShortcut = draft["send-prompt"];
  const newlineShortcut =
    sendShortcut.code === "Enter" &&
    !sendShortcut.primary &&
    !sendShortcut.alt &&
    !sendShortcut.shift
      ? "Shift+Enter"
      : "Enter";

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Keyboard Shortcuts</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Select a shortcut, then press the key combination you want to use.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          Saved shortcuts could not be refreshed. Current shortcuts remain active while we retry.
        </p>
      )}

      <div className="border border-border rounded-md divide-y divide-border-muted">
        {KEYBOARD_SHORTCUT_ACTIONS.map((action) => {
          const { label, description } = SHORTCUT_METADATA[action];
          const duplicate = duplicates.has(action);
          const active = recording === action;
          const shortcut = formatShortcut(draft[action]);
          const errorId = `shortcut-error-${action}`;
          return (
            <div key={action} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm text-foreground">{label}</p>
                <p className="text-xs text-muted-foreground">{description}</p>
                {duplicate && (
                  <p id={errorId} className="mt-1 text-xs text-destructive">
                    This shortcut is already in use.
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label={`${active ? "Recording" : "Record"} shortcut for ${label}. Current shortcut ${shortcut}`}
                aria-pressed={active}
                aria-invalid={duplicate || undefined}
                aria-describedby={duplicate ? errorId : undefined}
                onClick={() => setRecording((current) => (current === action ? null : action))}
                onKeyDown={(event) => handleKeyDown(action, event)}
                className={cn(
                  "min-w-32 rounded-sm border px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "border-ring bg-accent/10 text-accent ring-2 ring-ring/40"
                    : "border-border bg-muted text-foreground hover:border-foreground/30",
                  duplicate && "border-destructive text-destructive"
                )}
              >
                {active ? "Press shortcut" : shortcut}
              </button>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-sm text-muted-foreground">
        In the composer, {formatShortcut(sendShortcut)} sends and {newlineShortcut} creates a
        newline.
      </p>

      <div className="mt-6 flex gap-3">
        <Button onClick={handleSave} disabled={!dirty || duplicates.size > 0 || saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setDraft(DEFAULT_KEYBOARD_SHORTCUTS);
            setRecording(null);
          }}
          disabled={isDefault || saving}
        >
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}
