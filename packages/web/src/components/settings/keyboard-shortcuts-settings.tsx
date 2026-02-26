"use client";

import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { Badge } from "@/components/ui/badge";

export function KeyboardShortcutsSettings() {
  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Keyboard Shortcuts</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Use shortcuts for quick navigation and sending prompts.
      </p>

      <div className="border border-border rounded divide-y divide-border">
        <ShortcutRow label="Send prompt" shortcut={SHORTCUT_LABELS.SEND_PROMPT} />
        <ShortcutRow label="New session" shortcut={SHORTCUT_LABELS.NEW_SESSION} />
        <ShortcutRow label="Toggle sidebar" shortcut={SHORTCUT_LABELS.TOGGLE_SIDEBAR} />
      </div>

      <p className="mt-4 text-sm text-muted-foreground">
        In the composer, Cmd/Ctrl+Enter sends and Enter creates a newline.
      </p>
    </div>
  );
}

function ShortcutRow({ label, shortcut }: { label: string; shortcut: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-foreground">{label}</span>
      <Badge variant="kbd" className="px-2 py-1">
        {shortcut}
      </Badge>
    </div>
  );
}
