"use client";

import { useId, useState } from "react";
import { PlusIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { RULE_ICONS } from "./sign-in-allowlist-row";
import {
  detectRuleTypes,
  type AdmissionRuleType,
  type RuleCandidate,
} from "./sign-in-allowlist-rules";

const SUGGESTIONS: Record<AdmissionRuleType, { label: (value: string) => string; hint?: string }> =
  {
    allowedEmails: { label: (value) => `Allow ${value}` },
    allowedEmailDomains: {
      label: (value) => `Allow anyone with an @${value} email`,
      hint: "Subdomains aren't included",
    },
    allowedGitHubUsers: { label: (value) => `Allow GitHub user ${value}` },
    allowedGitHubOrganizations: {
      label: (value) => `Allow everyone in the ${value} GitHub org`,
      hint: "Members need a verified email",
    },
  };

/**
 * A single input that works out the rule type from what is typed, offering a choice only when
 * the input is ambiguous (a bare name could be a GitHub user or organization).
 */
export function SignInAllowlistAddRule({
  value,
  error,
  disabled,
  onValueChange,
  onAdd,
}: {
  value: string;
  error: string | null;
  disabled: boolean;
  onValueChange: (value: string) => void;
  /** Returns whether the rule was added. */
  onAdd: (candidate: RuleCandidate) => boolean;
}) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const candidates = detectRuleTypes(value);
  const highlighted = Math.min(active, Math.max(candidates.length - 1, 0));
  const open = focused && candidates.length > 0 && !error;

  function choose(index: number) {
    const candidate = candidates[index];
    if (candidate && onAdd(candidate)) setActive(0);
  }

  return (
    <div className="relative border-b border-border">
      <div className="flex items-center gap-3 px-4 transition focus-within:bg-muted">
        <PlusIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          role="combobox"
          aria-label="Add an email, domain, or GitHub name"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? `${id}-options` : undefined}
          aria-activedescendant={open ? `${id}-option-${highlighted}` : undefined}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          value={value}
          disabled={disabled}
          placeholder="Add an email, domain, or GitHub name"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            onValueChange(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && candidates.length) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((highlighted + step + candidates.length) % candidates.length);
            } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              choose(highlighted);
            } else if (event.key === "Escape" && value) {
              event.preventDefault();
              onValueChange("");
            }
          }}
        />
      </div>
      {open && (
        <ul
          id={`${id}-options`}
          role="listbox"
          aria-label="Rule suggestions"
          className="absolute inset-x-2 top-full z-20 mt-1 rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          {candidates.map((candidate, index) => {
            const Icon = RULE_ICONS[candidate.type];
            const suggestion = SUGGESTIONS[candidate.type];
            return (
              <li
                key={candidate.type}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={index === highlighted}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-sm text-foreground",
                  index === highlighted && "bg-muted"
                )}
                onMouseEnter={() => setActive(index)}
                // Keep focus in the input so the list doesn't close before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {suggestion.label(candidate.value.trim())}
                </span>
                {suggestion.hint && (
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {suggestion.hint}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="px-4 pb-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
