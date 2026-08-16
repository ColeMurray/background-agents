"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
import {
  applySkillCompletion,
  filterSkillSuggestions,
  findActiveSkillCompletion,
  type PromptSkillSuggestion,
} from "@/lib/prompt-skill-completion";
import { SparkleIcon } from "@/components/ui/icons";

type TextareaAutocompleteProps = Pick<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  | "aria-activedescendant"
  | "aria-autocomplete"
  | "aria-controls"
  | "aria-expanded"
  | "onBlur"
  | "onChange"
  | "onClick"
  | "onCompositionEnd"
  | "onCompositionStart"
  | "onFocus"
  | "onKeyDown"
  | "onKeyUp"
  | "onSelect"
>;

type PromptSkillAutocompleteProps = {
  value: string;
  skills: readonly PromptSkillSuggestion[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onValueChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  direction?: "up" | "down";
  loadState?: "ready" | "loading" | "error";
  maxLength?: number;
  disabled?: boolean;
  children: (inputProps: TextareaAutocompleteProps) => ReactNode;
};

type Cursor = { start: number; end: number };
type ActiveSelection = { key: string; index: number };

function cursorFromInput(input: HTMLTextAreaElement): Cursor {
  return { start: input.selectionStart, end: input.selectionEnd };
}

function completionStateKey(value: string, cursor: Cursor): string {
  return `${value}\u0000${cursor.start}\u0000${cursor.end}`;
}

export function PromptSkillAutocomplete({
  value,
  skills,
  inputRef,
  onValueChange,
  onKeyDown,
  direction = "up",
  loadState = "ready",
  maxLength,
  disabled = false,
  children,
}: PromptSkillAutocompleteProps) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [activeSelection, setActiveSelection] = useState<ActiveSelection>({ key: "", index: 0 });
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const instanceId = useId();
  const listboxId = `${instanceId}-skill-listbox`;
  const optionId = (index: number) => `${instanceId}-skill-option-${index}`;
  const completion =
    focused && !disabled && !composing && cursor
      ? findActiveSkillCompletion(value, cursor.start, cursor.end)
      : null;
  const suggestions = filterSkillSuggestions(skills, completion);
  const suggestionsKey = completion
    ? `${completion.trigger}${completion.query}\u0000${suggestions
        .map((skill) => skill.skillId)
        .join("\u0000")}`
    : "";
  const activeIndex =
    activeSelection.key === suggestionsKey
      ? Math.min(activeSelection.index, Math.max(0, suggestions.length - 1))
      : 0;
  const completionKey = completion && cursor ? completionStateKey(value, cursor) : null;
  const open = completion !== null && completionKey !== dismissedKey && focused;
  const hasSuggestions = suggestions.length > 0;

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-option-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, open]);

  const updateCursor = (input: HTMLTextAreaElement) => {
    const nextCursor = cursorFromInput(input);
    setCursor(nextCursor);
    setDismissedKey((current) =>
      current === completionStateKey(input.value, nextCursor) ? current : null
    );
  };

  const selectSuggestion = (skill: PromptSkillSuggestion) => {
    if (!completion) return;
    const next = applySkillCompletion(value, completion, skill.name, maxLength);
    if (!next) {
      setDismissedKey(completionKey);
      return;
    }
    setDismissedKey(null);
    setCursor({ start: next.caret, end: next.caret });
    onValueChange(next.value);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(next.caret, next.caret);
    });
  };

  const inputProps: TextareaAutocompleteProps = {
    "aria-autocomplete": "list",
    "aria-expanded": open,
    "aria-controls": open ? listboxId : undefined,
    "aria-activedescendant": open && hasSuggestions ? optionId(activeIndex) : undefined,
    onFocus: (event) => {
      setFocused(true);
      setDismissedKey(null);
      updateCursor(event.currentTarget);
    },
    onBlur: () => setFocused(false),
    onChange: (event) => {
      updateCursor(event.currentTarget);
      onValueChange(event.currentTarget.value);
    },
    onClick: (event) => {
      setDismissedKey(null);
      updateCursor(event.currentTarget);
    },
    onSelect: (event) => updateCursor(event.currentTarget),
    onKeyUp: (event) => {
      if (event.key !== "Escape") updateCursor(event.currentTarget);
    },
    onCompositionStart: () => setComposing(true),
    onCompositionEnd: (event) => {
      setComposing(false);
      updateCursor(event.currentTarget);
    },
    onKeyDown: (event) => {
      if (event.nativeEvent.isComposing || composing) {
        onKeyDown?.(event);
        return;
      }
      const unmodified = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (open && hasSuggestions && unmodified && event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSelection({
          key: suggestionsKey,
          index: (activeIndex + 1) % suggestions.length,
        });
        return;
      }
      if (open && hasSuggestions && unmodified && event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSelection({
          key: suggestionsKey,
          index: activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1,
        });
        return;
      }
      if (open && hasSuggestions && unmodified && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        selectSuggestion(suggestions[activeIndex]);
        return;
      }
      if (open && event.key === "Escape") {
        event.preventDefault();
        setDismissedKey(completionKey);
        return;
      }
      onKeyDown?.(event);
    },
  };

  const position = direction === "up" ? "bottom-full mb-3" : "top-full mt-3";

  return (
    <>
      {children(inputProps)}
      {open && completion && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Managed skills"
          aria-busy={loadState === "loading"}
          data-testid="prompt-skill-suggestions"
          className={`absolute ${position} left-0 right-0 z-50 overflow-hidden rounded-xl border border-border bg-background p-2 shadow-2xl`}
        >
          <div className="flex items-center justify-between gap-4 px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Skills
            </span>
            <span className="text-xs text-muted-foreground">
              {loadState === "loading"
                ? "Loading..."
                : loadState === "error"
                  ? "Unavailable"
                  : hasSuggestions
                    ? `${suggestions.length} available`
                    : ""}
            </span>
          </div>
          <div ref={listRef} className="max-h-[min(22rem,50vh)] overflow-y-auto">
            {loadState === "loading" ? (
              <div className="flex items-center gap-3 rounded-lg px-3 py-4 text-sm text-muted-foreground">
                <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                Loading managed skills...
              </div>
            ) : loadState === "error" ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                Managed skills could not be loaded. Try again shortly.
              </div>
            ) : hasSuggestions ? (
              suggestions.map((skill, index) => (
                <button
                  key={skill.skillId}
                  id={optionId(index)}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-option-index={index}
                  onPointerMove={() => setActiveSelection({ key: suggestionsKey, index })}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    selectSuggestion(skill);
                  }}
                  className={`grid w-full grid-cols-[minmax(0,0.65fr)_minmax(0,1fr)] items-center gap-4 rounded-lg px-3 py-2.5 text-left transition sm:grid-cols-[minmax(0,0.55fr)_minmax(0,1fr)_auto] ${
                    index === activeIndex ? "bg-accent-muted" : "hover:bg-muted"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2.5 font-mono text-sm font-medium text-foreground">
                    <SparkleIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      {completion.trigger}
                      {skill.name}
                    </span>
                  </span>
                  <span className="truncate text-xs text-muted-foreground sm:text-sm">
                    {skill.description}
                  </span>
                  <span className="hidden text-xs text-muted-foreground sm:block">Managed</span>
                </button>
              ))
            ) : (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                No managed skills match
                {completion.query ? ` "${completion.query}"` : " this session"}.
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
