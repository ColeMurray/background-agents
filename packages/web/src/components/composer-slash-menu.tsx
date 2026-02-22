"use client";

import type { ComposerAutocompleteState } from "@/lib/composer-autocomplete";
import type { ComposerCommand } from "@/lib/composer-commands";

interface ComposerSlashMenuProps {
  listId: string;
  state: ComposerAutocompleteState;
  options: ComposerCommand[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (command: ComposerCommand) => void;
}

export function ComposerSlashMenu({
  listId,
  state,
  options,
  activeIndex,
  onHover,
  onSelect,
}: ComposerSlashMenuProps) {
  if (state === "closed") return null;

  if (state === "loading" || state === "empty" || state === "error") {
    const message =
      state === "loading"
        ? "Loading workflows..."
        : state === "empty"
          ? "No matching workflows"
          : "Unable to load workflows";

    return (
      <div className="border-t border-border-muted px-3 py-2 text-xs text-muted-foreground">
        {message}
      </div>
    );
  }

  return (
    <div
      className="border-t border-border-muted"
      role="listbox"
      id={listId}
      aria-label="Workflow suggestions"
    >
      {options.map((command, index) => {
        const active = index === activeIndex;
        return (
          <button
            key={command.id}
            id={`${listId}-option-${index}`}
            role="option"
            aria-selected={active}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => {
              // Keep textarea focus/caret stable while selecting.
              event.preventDefault();
              onSelect(command);
            }}
            className={`w-full px-3 py-2 text-left transition ${
              active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-accent">/{command.command}</span>
              <span className="text-sm">{command.title}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{command.description}</p>
          </button>
        );
      })}
    </div>
  );
}
