"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";
import useSWR from "swr";
import { sessionReferences, referenceMarker } from "@open-inspect/shared/session-references";
import { findSessionCompletion } from "@/lib/prompt-session-completion";
import { buildSessionsPageKey, fetchSessionListPage } from "@/lib/session-list";
import { PromptSkillSuggestionPanel } from "@/components/prompt-skill-suggestion-panel";
import {
  applySkillCompletion,
  filterSkillSuggestions,
  findActiveSkillCompletion,
  type PromptSkillSuggestion,
  type PromptSkillSuggestionSource,
} from "@/lib/prompt-skill-completion";

type Cursor = { start: number; end: number };

function sameCursor(left: Cursor, right: Cursor): boolean {
  return left.start === right.start && left.end === right.end;
}

type PromptSkillTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "defaultValue" | "onChange" | "value"
> & {
  value: string;
  suggestions: PromptSkillSuggestionSource;
  onValueChange: (value: string) => void;
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
    const [cursor, setCursor] = useState<Cursor | null>(null);
    const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
    const [dismissedAt, setDismissedAt] = useState<{ value: string; cursor: Cursor } | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const instanceId = useId();
    const listboxId = `${instanceId}-skill-listbox`;
    const optionId = (skillId: string) => `${instanceId}-skill-option-${skillId}`;
    const skills = suggestionSource.status === "ready" ? suggestionSource.skills : [];
    const completion = cursor ? findActiveSkillCompletion(value, cursor.start, cursor.end) : null;
    const matchingSkills = filterSkillSuggestions(skills, completion);
    const activeSkill =
      matchingSkills.find((skill) => skill.skillId === activeSkillId) ?? matchingSkills[0];
    const dismissed =
      dismissedAt !== null &&
      dismissedAt.value === value &&
      cursor !== null &&
      sameCursor(dismissedAt.cursor, cursor);
    const open = completion !== null && !dismissed;
    const referenceCompletion =
      cursor && !disabled && sessionReferences(value).length < 3
        ? findSessionCompletion(value, cursor.start, cursor.end)
        : null;
    const referenceOpen = referenceCompletion !== null && !dismissed;
    const referenceQuery = useSWR(
      referenceOpen ? buildSessionsPageKey({ q: referenceCompletion.query, limit: 10 }) : null,
      fetchSessionListPage
    );
    const referenceSessions = (referenceQuery.data?.sessions ?? []).filter(
      (session) => !sessionReferences(value).some((reference) => reference.id === session.id)
    );
    const [activeReferenceIndex, setActiveReferenceIndex] = useState(0);
    const referenceIndex = Math.min(
      activeReferenceIndex,
      Math.max(referenceSessions.length - 1, 0)
    );
    const selectReference = (id: string, label: string) => {
      if (!referenceCompletion) return;
      const marker = referenceMarker(id, label) + " ";
      const next =
        value.slice(0, referenceCompletion.start) + marker + value.slice(referenceCompletion.end);
      if (maxLength && next.length > maxLength) return;
      const caret = referenceCompletion.start + marker.length;
      onValueChange(next);
      setCursor({ start: caret, end: caret });
      setActiveReferenceIndex(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(caret, caret);
      });
    };

    const suggestionStatus = !open
      ? ""
      : suggestionSource.status === "loading"
        ? "Loading managed skill suggestions."
        : suggestionSource.status === "error"
          ? "Managed skill suggestions unavailable."
          : matchingSkills.length === 0
            ? "No managed skill suggestions available."
            : `${matchingSkills.length} managed skill suggestion${matchingSkills.length === 1 ? "" : "s"} available.`;

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
      const skillIds = skillIdsAt(input.value, nextCursor);
      setCursor(nextCursor);
      setActiveSkillId((current) =>
        current !== null && skillIds.includes(current) ? current : (skillIds[0] ?? null)
      );
      setDismissedAt((current) =>
        !reopen && current?.value === input.value && sameCursor(current.cursor, nextCursor)
          ? current
          : null
      );
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
        setDismissedAt({ value, cursor });
        return;
      }
      onValueChange(next.value);
      setCursor({ start: next.caret, end: next.caret });
      setActiveSkillId(null);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(next.caret, next.caret);
      });
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || composingRef.current) {
        onKeyDown?.(event);
        return;
      }
      const unmodified = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (
        referenceOpen &&
        unmodified &&
        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
        referenceSessions.length
      ) {
        event.preventDefault();
        setActiveReferenceIndex(
          (referenceIndex + (event.key === "ArrowDown" ? 1 : -1) + referenceSessions.length) %
            referenceSessions.length
        );
        return;
      }
      if (
        referenceOpen &&
        unmodified &&
        (event.key === "Enter" || event.key === "Tab") &&
        referenceSessions[referenceIndex]
      ) {
        event.preventDefault();
        const session = referenceSessions[referenceIndex];
        selectReference(session.id, session.title ?? session.id);
        return;
      }
      if (referenceOpen && event.key === "Escape" && cursor) {
        event.preventDefault();
        setDismissedAt({ value, cursor });
        return;
      }
      if (open && activeSkill && unmodified && event.key === "ArrowDown") {
        event.preventDefault();
        const index = Math.max(0, matchingSkills.indexOf(activeSkill));
        setActiveSkillId(matchingSkills[(index + 1) % matchingSkills.length].skillId);
        return;
      }
      if (open && activeSkill && unmodified && event.key === "ArrowUp") {
        event.preventDefault();
        const index = Math.max(0, matchingSkills.indexOf(activeSkill));
        setActiveSkillId(
          matchingSkills[(index - 1 + matchingSkills.length) % matchingSkills.length].skillId
        );
        return;
      }
      if (open && activeSkill && unmodified && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        selectSkill(activeSkill);
        return;
      }
      if (open && event.key === "Escape" && cursor) {
        event.preventDefault();
        setDismissedAt({ value, cursor });
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
          aria-controls={referenceOpen ? `${instanceId}-references` : open ? listboxId : undefined}
          aria-activedescendant={
            referenceOpen && referenceSessions.length
              ? `${instanceId}-reference-${referenceIndex}`
              : activeOptionId
          }
          onBlur={(event) => {
            setCursor(null);
            onBlur?.(event);
          }}
          onChange={(event) => {
            if (!composingRef.current) syncInput(event.currentTarget);
            onValueChange(event.currentTarget.value);
          }}
          onClick={(event) => {
            syncInput(event.currentTarget, true);
            onClick?.(event);
          }}
          onCompositionStart={(event) => {
            composingRef.current = true;
            setCursor(null);
            onCompositionStart?.(event);
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            syncInput(event.currentTarget, true);
            onCompositionEnd?.(event);
          }}
          onFocus={(event) => {
            syncInput(event.currentTarget, true);
            onFocus?.(event);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => {
            if (event.key !== "Escape" && !composingRef.current) {
              syncInput(event.currentTarget);
            }
            onKeyUp?.(event);
          }}
          onSelect={(event) => {
            if (!composingRef.current) syncInput(event.currentTarget);
            onSelect?.(event);
          }}
        />
        {referenceOpen && (
          <div
            id={`${instanceId}-references`}
            role="listbox"
            aria-label="Session references"
            className="border border-border bg-background p-2 max-h-60 overflow-auto"
          >
            {referenceQuery.isLoading ? (
              <p role="status">Loading sessions…</p>
            ) : referenceQuery.error ? (
              <p role="alert">Session references unavailable.</p>
            ) : !referenceSessions.length ? (
              <p>No matching sessions.</p>
            ) : (
              referenceSessions.map((session, index) => (
                <button
                  key={session.id}
                  id={`${instanceId}-reference-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === referenceIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveReferenceIndex(index)}
                  onClick={() => selectReference(session.id, session.title ?? session.id)}
                  className={`block w-full text-left px-3 py-2 ${index === referenceIndex ? "bg-muted" : ""}`}
                >
                  <span>{session.title ?? session.id}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {session.repoOwner}/{session.repoName} · {session.status}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
        {!!sessionReferences(value).length && (
          <div aria-label="Attached session references" className="flex flex-wrap gap-2 px-3 py-2">
            {sessionReferences(value).map((reference) => (
              <button
                key={reference.marker}
                type="button"
                disabled={disabled}
                onClick={() => onValueChange(value.replace(reference.marker, ""))}
                className="rounded border border-border px-2 py-1 text-xs"
                aria-label={`Remove reference ${reference.label}`}
              >
                #{reference.label} ×
              </button>
            ))}
          </div>
        )}
        <span role="status" className="sr-only">
          {suggestionStatus}
        </span>
        {open && completion && (
          <PromptSkillSuggestionPanel
            id={listboxId}
            optionId={optionId}
            completion={completion}
            source={suggestionSource}
            matchingSkills={matchingSkills}
            activeSkillId={activeSkill?.skillId}
            listRef={listRef}
            onActivate={setActiveSkillId}
            onSelect={selectSkill}
          />
        )}
      </>
    );
  }
);
