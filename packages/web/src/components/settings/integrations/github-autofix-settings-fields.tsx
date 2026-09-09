"use client";

import { useEffect, useRef, useState } from "react";
import {
  GITHUB_AUTOFIX_DEFAULT_ATTEMPT_LIMIT,
  type ResolvedGitHubAutofixSettings,
} from "@open-inspect/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

function parseBotUsernames(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function parseAttemptLimit(value: string): number | null {
  const parsed = Number(value);
  return value !== "" && Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function GitHubAutofixSettingsFields({
  value,
  onChange,
  onDirty,
  compact = false,
}: {
  value: ResolvedGitHubAutofixSettings;
  onChange: (
    value: ResolvedGitHubAutofixSettings,
    changedKey: keyof ResolvedGitHubAutofixSettings
  ) => void;
  onDirty: () => void;
  compact?: boolean;
}) {
  const [botUsernames, setBotUsernames] = useState(() => value.allowedReviewBots.join(", "));
  const editingBotUsernames = useRef(false);
  const [attemptLimit, setAttemptLimit] = useState(() =>
    String(value.maxAttemptsPerPrPer24Hours ?? GITHUB_AUTOFIX_DEFAULT_ATTEMPT_LIMIT)
  );

  useEffect(() => {
    if (!editingBotUsernames.current) {
      setBotUsernames(value.allowedReviewBots.join(", "));
    }
  }, [value.allowedReviewBots]);

  useEffect(() => {
    if (value.maxAttemptsPerPrPer24Hours !== null) {
      setAttemptLimit(String(value.maxAttemptsPerPrPer24Hours));
    }
  }, [value.maxAttemptsPerPrPer24Hours]);

  const update = <K extends keyof ResolvedGitHubAutofixSettings>(
    key: K,
    next: ResolvedGitHubAutofixSettings[K]
  ) => onChange({ ...value, [key]: next }, key);
  const rowClass = compact
    ? "flex items-center justify-between gap-3 py-1"
    : "flex items-center justify-between gap-3 px-3 py-2 border border-border rounded-sm";

  return (
    <div className="space-y-2">
      {[
        {
          key: "enabled" as const,
          label: "Enable Autofix",
          description: "Admit new eligible feedback into the owning session.",
        },
        {
          key: "reviewsEnabled" as const,
          label: "Submitted reviews",
          description: "One complete submitted review creates one attempt.",
        },
        {
          key: "prCommentsEnabled" as const,
          label: "Plain human PR comments",
          description: "Mentions continue to use the fresh-session flow.",
        },
        {
          key: "openInspectReviewsEnabled" as const,
          label: "Open Inspect reviews",
          description:
            "Allow reviews from the configured Open Inspect App, regardless of workflow.",
        },
      ].map((field) => (
        <label key={field.key} className={rowClass}>
          <span>
            <span className="block text-sm text-foreground">{field.label}</span>
            {!compact && (
              <span className="block text-xs text-muted-foreground">{field.description}</span>
            )}
          </span>
          <Switch
            aria-label={field.label}
            checked={value[field.key]}
            onCheckedChange={(checked) => update(field.key, checked)}
          />
        </label>
      ))}

      <label className="block">
        <span className="block text-xs font-medium text-muted-foreground mb-1">
          Exact third-party review bots
        </span>
        <Input
          aria-label="Exact third-party review bots"
          value={botUsernames}
          onChange={(event) => {
            const next = event.target.value;
            editingBotUsernames.current = true;
            setBotUsernames(next);
            update("allowedReviewBots", parseBotUsernames(next));
            onDirty();
          }}
          onBlur={() => {
            editingBotUsernames.current = false;
            setBotUsernames(value.allowedReviewBots.join(", "));
          }}
          placeholder="coderabbitai[bot]"
          className={compact ? "h-8 text-xs" : undefined}
        />
        <span className="block text-xs text-muted-foreground mt-1">
          Comma-separated exact usernames. Bot-authored top-level comments are not eligible.
        </span>
        {value.allowedReviewBots.length > 0 && (
          <span className="block text-xs text-amber-600 dark:text-amber-400 mt-1">
            Bot-authored feedback is untrusted input and can initiate autonomous work. Allow only
            exact bot identities you trust for this repository.
          </span>
        )}
      </label>

      <div>
        <span className="block text-xs font-medium text-muted-foreground mb-1">
          Attempts per PR per 24 hours
        </span>
        <Input
          aria-label="Attempts per PR per 24 hours"
          type="number"
          min={1}
          step={1}
          disabled={value.maxAttemptsPerPrPer24Hours === null}
          value={attemptLimit}
          onChange={(event) => {
            const next = event.target.value;
            setAttemptLimit(next);
            const parsed = parseAttemptLimit(next);
            if (parsed !== null) {
              update("maxAttemptsPerPrPer24Hours", parsed);
            }
          }}
          onBlur={() => {
            setAttemptLimit(
              String(value.maxAttemptsPerPrPer24Hours ?? GITHUB_AUTOFIX_DEFAULT_ATTEMPT_LIMIT)
            );
          }}
          className={compact ? "h-8 text-xs" : "max-w-32"}
        />
        <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            aria-label="No Autofix attempt limit"
            checked={value.maxAttemptsPerPrPer24Hours === null}
            onCheckedChange={(checked) => {
              update(
                "maxAttemptsPerPrPer24Hours",
                checked
                  ? null
                  : (parseAttemptLimit(attemptLimit) ?? GITHUB_AUTOFIX_DEFAULT_ATTEMPT_LIMIT)
              );
            }}
          />
          No limit
        </label>
        {(value.maxAttemptsPerPrPer24Hours === null ||
          value.maxAttemptsPerPrPer24Hours > GITHUB_AUTOFIX_DEFAULT_ATTEMPT_LIMIT) && (
          <span className="block text-xs text-amber-600 dark:text-amber-400 mt-1">
            Higher or unlimited attempts increase autonomous work and spend. Change this only after
            reviewing dogfood volume and queue health.
          </span>
        )}
      </div>
    </div>
  );
}
