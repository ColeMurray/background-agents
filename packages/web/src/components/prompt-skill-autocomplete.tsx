"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";
import { PromptSkillSuggestionPanel } from "@/components/prompt-skill-suggestion-panel";
import {
  applySkillCompletion,
  filterSkillSuggestions,
  findActiveSkillCompletion,
  type PromptSkillSuggestion,
  type PromptSkillSuggestionSource,
} from "@/lib/prompt-skill-completion";

type Cursor = { start: number; end: number };

type InteractionState =
  | { status: "idle" }
  | { status: "composing" }
  | { status: "dismissed"; value: string; cursor: Cursor }
  | { status: "active"; cursor: Cursor; activeSkillId: string | null };

type InteractionEvent =
  | { type: "SYNC"; value: string; cursor: Cursor; skillIds: string[]; reopen?: boolean }
  | { type: "MOVE"; delta: -1 | 1; skillIds: string[] }
  | { type: "ACTIVATE"; skillId: string }
  | { type: "DISMISS"; value: string; cursor: Cursor }
  | { type: "START_COMPOSITION" }
  | { type: "BLUR" };

const INITIAL_INTERACTION_STATE: InteractionState = { status: "idle" };

function sameCursor(left: Cursor, right: Cursor): boolean {
  return left.start === right.start && left.end === right.end;
}

function interactionReducer(state: InteractionState, event: InteractionEvent): InteractionState {
  switch (event.type) {
    case "SYNC": {
      if (
        !event.reopen &&
        state.status === "dismissed" &&
        state.value === event.value &&
        sameCursor(state.cursor, event.cursor)
      ) {
        return state;
      }
      const activeSkillId =
        state.status === "active" &&
        state.activeSkillId !== null &&
        event.skillIds.includes(state.activeSkillId)
          ? state.activeSkillId
          : (event.skillIds[0] ?? null);
      return { status: "active", cursor: event.cursor, activeSkillId };
    }
    case "MOVE": {
      if (state.status !== "active" || event.skillIds.length === 0) return state;
      const currentIndex = Math.max(0, event.skillIds.indexOf(state.activeSkillId ?? ""));
      const nextIndex =
        (currentIndex + event.delta + event.skillIds.length) % event.skillIds.length;
      return { ...state, activeSkillId: event.skillIds[nextIndex] };
    }
    case "ACTIVATE":
      return state.status === "active" ? { ...state, activeSkillId: event.skillId } : state;
    case "DISMISS":
      return { status: "dismissed", value: event.value, cursor: event.cursor };
    case "START_COMPOSITION":
      return { status: "composing" };
    case "BLUR":
      return { status: "idle" };
  }
}

type PromptSkillTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "defaultValue" | "onChange" | "value"
> & {
  value: string;
  suggestions: PromptSkillSuggestionSource;
  onValueChange: (value: string) => void;
  direction?: "up" | "down";
};

function cursorFromInput(input: HTMLTextAreaElement): Cursor {
  return { start: input.selectionStart, end: input.selectionEnd };
}

export const PromptSkillTextarea = forwardRef<HTMLTextAreaElement, PromptSkillTextareaProps>(
  function PromptSkillTextarea(
    {
      value,
      suggestions: suggestionSource,
      onValueChange,
      direction = "up",
      disabled = false,
      maxLength,
      onBlur,
      onClick,
      onCompositionEnd,
      onCompositionStart,
      onFocus,
      onKeyDown,
      onKeyUp,
      onSelect,
      ...textareaProps
    },
    forwardedRef
  ) {
    const [interaction, dispatch] = useReducer(interactionReducer, INITIAL_INTERACTION_STATE);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const instanceId = useId();
    const listboxId = `${instanceId}-skill-listbox`;
    const optionId = (skillId: string) => `${instanceId}-skill-option-${skillId}`;
    const skills = suggestionSource.status === "ready" ? suggestionSource.skills : [];
    const cursor = interaction.status === "active" ? interaction.cursor : null;
    const activeSkillId = interaction.status === "active" ? interaction.activeSkillId : null;
    const completion = cursor ? findActiveSkillCompletion(value, cursor.start, cursor.end) : null;
    const matchingSkills = filterSkillSuggestions(skills, completion);
    const activeSkill =
      matchingSkills.find((skill) => skill.skillId === activeSkillId) ?? matchingSkills[0];
    const open = interaction.status === "active" && completion !== null;

    const setInputRef = useCallback(
      (input: HTMLTextAreaElement | null) => {
        inputRef.current = input;
        if (typeof forwardedRef === "function") forwardedRef(input);
        else if (forwardedRef) forwardedRef.current = input;
      },
      [forwardedRef]
    );

    const skillIdsAt = (nextValue: string, nextCursor: Cursor): string[] => {
      const nextCompletion = findActiveSkillCompletion(nextValue, nextCursor.start, nextCursor.end);
      return filterSkillSuggestions(skills, nextCompletion).map((skill) => skill.skillId);
    };

    const syncInput = (input: HTMLTextAreaElement, reopen = false) => {
      const nextCursor = cursorFromInput(input);
      dispatch({
        type: "SYNC",
        value: input.value,
        cursor: nextCursor,
        skillIds: skillIdsAt(input.value, nextCursor),
        reopen,
      });
    };

    useEffect(() => {
      if (!open || !activeSkill) return;
      listRef.current
        ?.querySelector(`[data-skill-id="${activeSkill.skillId}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
    }, [activeSkill, open]);

    const selectSkill = (skill: PromptSkillSuggestion) => {
      if (!completion || !cursor) return;
      const next = applySkillCompletion(value, completion, skill.name, maxLength);
      if (!next) {
        dispatch({ type: "DISMISS", value, cursor });
        return;
      }
      onValueChange(next.value);
      dispatch({
        type: "SYNC",
        value: next.value,
        cursor: { start: next.caret, end: next.caret },
        skillIds: [],
      });
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(next.caret, next.caret);
      });
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || interaction.status === "composing") {
        onKeyDown?.(event);
        return;
      }
      const unmodified = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      const skillIds = matchingSkills.map((skill) => skill.skillId);
      if (open && activeSkill && unmodified && event.key === "ArrowDown") {
        event.preventDefault();
        dispatch({ type: "MOVE", delta: 1, skillIds });
        return;
      }
      if (open && activeSkill && unmodified && event.key === "ArrowUp") {
        event.preventDefault();
        dispatch({ type: "MOVE", delta: -1, skillIds });
        return;
      }
      if (open && activeSkill && unmodified && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        selectSkill(activeSkill);
        return;
      }
      if (open && event.key === "Escape" && cursor) {
        event.preventDefault();
        dispatch({ type: "DISMISS", value, cursor });
        return;
      }
      onKeyDown?.(event);
    };

    const activeOptionId = open && activeSkill ? optionId(activeSkill.skillId) : undefined;

    return (
      <>
        <textarea
          {...textareaProps}
          ref={setInputRef}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={activeOptionId}
          onBlur={(event) => {
            dispatch({ type: "BLUR" });
            onBlur?.(event);
          }}
          onChange={(event) => {
            if (interaction.status !== "composing") syncInput(event.currentTarget);
            onValueChange(event.currentTarget.value);
          }}
          onClick={(event) => {
            syncInput(event.currentTarget, true);
            onClick?.(event);
          }}
          onCompositionStart={(event) => {
            dispatch({ type: "START_COMPOSITION" });
            onCompositionStart?.(event);
          }}
          onCompositionEnd={(event) => {
            syncInput(event.currentTarget, true);
            onCompositionEnd?.(event);
          }}
          onFocus={(event) => {
            syncInput(event.currentTarget, true);
            onFocus?.(event);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => {
            if (event.key !== "Escape" && interaction.status !== "composing") {
              syncInput(event.currentTarget);
            }
            onKeyUp?.(event);
          }}
          onSelect={(event) => {
            if (interaction.status !== "composing") syncInput(event.currentTarget);
            onSelect?.(event);
          }}
        />
        {open && completion && (
          <PromptSkillSuggestionPanel
            id={listboxId}
            optionId={optionId}
            direction={direction}
            completion={completion}
            source={suggestionSource}
            matchingSkills={matchingSkills}
            activeSkillId={activeSkill?.skillId}
            listRef={listRef}
            onActivate={(skillId) => dispatch({ type: "ACTIVATE", skillId })}
            onSelect={selectSkill}
          />
        )}
      </>
    );
  }
);
