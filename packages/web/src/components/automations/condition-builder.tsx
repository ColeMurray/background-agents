"use client";

import { useMemo, useState } from "react";
import type { TriggerCondition, AutomationEventSource, JsonPathFilter } from "@open-inspect/shared";
import { conditionRegistry } from "@open-inspect/shared";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { ChevronDownIcon } from "@/components/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSlackChannels } from "@/hooks/use-slack-channels";

interface ConditionBuilderProps {
  conditions: TriggerCondition[];
  onChange: (conditions: TriggerCondition[]) => void;
  triggerSource: AutomationEventSource;
}

const CONDITION_LABELS: Record<string, string> = {
  sentry_project: "Sentry Project",
  sentry_level: "Error Level",
  jsonpath: "JSONPath Filter",
  branch: "Head branch",
  target_branch: "Target branch",
  label: "Label",
  path_glob: "Path Glob",
  actor: "Actor",
  check_conclusion: "Check Conclusion",
  linear_status: "Linear Status",
  text_match: "Message Text",
  slack_channel: "Slack Channel",
  slack_actor: "Slack User",
};

const TEXT_MATCH_MODES = ["contains", "exact", "regex"] as const;

const SENTRY_LEVELS = ["warning", "error", "fatal"];
export const CHECK_CONCLUSION_OPTIONS = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "timed_out",
] as const;

export function ConditionBuilder({ conditions, onChange, triggerSource }: ConditionBuilderProps) {
  // Get available condition types for this trigger source
  const availableTypes = Object.entries(conditionRegistry)
    .filter(([_, handler]) => handler.appliesTo.includes(triggerSource))
    .map(([type]) => type);

  const addCondition = (type: string) => {
    let newCondition: TriggerCondition;
    switch (type) {
      case "sentry_project":
        newCondition = { type: "sentry_project", operator: "any_of", value: [] };
        break;
      case "sentry_level":
        newCondition = { type: "sentry_level", operator: "any_of", value: [] };
        break;
      case "jsonpath":
        newCondition = {
          type: "jsonpath",
          operator: "all_match",
          value: [{ path: "$.", comparison: "eq", value: "" }],
        };
        break;
      case "branch":
        newCondition = { type: "branch", operator: "glob_match", value: [] };
        break;
      case "target_branch":
        newCondition = { type: "target_branch", operator: "glob_match", value: [] };
        break;
      case "label":
        newCondition = { type: "label", operator: "any_of", value: [] };
        break;
      case "path_glob":
        newCondition = { type: "path_glob", operator: "any_match", value: [] };
        break;
      case "actor":
        newCondition = { type: "actor", operator: "include", value: [] };
        break;
      case "check_conclusion":
        newCondition = {
          type: "check_conclusion",
          operator: "eq",
          value: CHECK_CONCLUSION_OPTIONS[0],
        };
        break;
      case "text_match":
        newCondition = { type: "text_match", operator: "contains", value: { pattern: "" } };
        break;
      case "slack_channel":
        newCondition = { type: "slack_channel", operator: "any_of", value: [] };
        break;
      case "slack_actor":
        newCondition = { type: "slack_actor", operator: "include", value: [] };
        break;
      default:
        return;
    }
    onChange([...conditions, newCondition]);
  };

  const removeCondition = (index: number) => {
    onChange(conditions.filter((_, i) => i !== index));
  };

  const updateCondition = (index: number, updated: TriggerCondition) => {
    const newConditions = [...conditions];
    newConditions[index] = updated;
    onChange(newConditions);
  };

  return (
    <div className="space-y-3">
      {conditions.map((condition, index) => (
        <div
          key={index}
          className="flex items-start gap-2 p-3 border border-border-muted rounded-md bg-card"
        >
          <div className="flex-1 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              {CONDITION_LABELS[condition.type] || condition.type}
            </div>
            <ConditionEditor condition={condition} onChange={(c) => updateCondition(index, c)} />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => removeCondition(index)}
            className="text-muted-foreground hover:text-destructive mt-0.5"
          >
            Remove
          </Button>
        </div>
      ))}

      {availableTypes.length > 0 && (
        <Select onValueChange={addCondition}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Add condition..." />
          </SelectTrigger>
          <SelectContent>
            {availableTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {CONDITION_LABELS[type] || type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function ConditionEditor({
  condition,
  onChange,
}: {
  condition: TriggerCondition;
  onChange: (c: TriggerCondition) => void;
}) {
  switch (condition.type) {
    case "sentry_project":
    case "sentry_level":
      return (
        <TagInput
          values={condition.value}
          onChange={(value) => onChange({ ...condition, value })}
          placeholder={
            condition.type === "sentry_level"
              ? "Add level (warning, error, fatal)..."
              : "Add project slug..."
          }
          suggestions={condition.type === "sentry_level" ? SENTRY_LEVELS : undefined}
        />
      );
    case "jsonpath":
      return (
        <JsonPathEditor
          filters={condition.value}
          onChange={(value) => onChange({ ...condition, value })}
        />
      );
    case "branch":
      return (
        <TagInput
          values={condition.value}
          onChange={(value) => onChange({ ...condition, value })}
          placeholder="Head branch pattern (PR source, e.g. main, feature/*)..."
        />
      );
    case "target_branch":
      return (
        <TagInput
          values={condition.value}
          onChange={(value) => onChange({ ...condition, value })}
          placeholder="PR merge base pattern (PR events only, e.g. main, release/*)..."
        />
      );
    case "label":
      return (
        <TagInput
          values={condition.value}
          onChange={(value) => onChange({ ...condition, value })}
          placeholder="Add label..."
        />
      );
    case "path_glob":
      return (
        <TagInput
          values={condition.value}
          onChange={(value) => onChange({ ...condition, value })}
          placeholder="Add path pattern (e.g., src/**, *.ts)..."
        />
      );
    case "actor":
      return (
        <div className="space-y-2">
          <Select
            value={condition.operator}
            onValueChange={(v) => onChange({ ...condition, operator: v as "include" | "exclude" })}
          >
            <SelectTrigger className="w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="include">include</SelectItem>
              <SelectItem value="exclude">exclude</SelectItem>
            </SelectContent>
          </Select>
          <TagInput
            values={condition.value}
            onChange={(value) => onChange({ ...condition, value })}
            placeholder="Add actor username..."
          />
        </div>
      );
    case "check_conclusion":
      return (
        <Select value={condition.value} onValueChange={(v) => onChange({ ...condition, value: v })}>
          <SelectTrigger className="w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHECK_CONCLUSION_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "text_match": {
      const flags = condition.value.flags ?? "";
      const caseInsensitive = flags.includes("i");
      return (
        <div className="space-y-2">
          <Select
            value={condition.operator}
            onValueChange={(v) =>
              onChange({ ...condition, operator: v as (typeof TEXT_MATCH_MODES)[number] })
            }
          >
            <SelectTrigger className="w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEXT_MATCH_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {mode}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="text"
            value={condition.value.pattern}
            onChange={(e) =>
              onChange({ ...condition, value: { ...condition.value, pattern: e.target.value } })
            }
            placeholder={
              condition.operator === "regex"
                ? "Regular expression, e.g. \\b(deploy|release)\\b"
                : condition.operator === "exact"
                  ? "Exact message text to match"
                  : "Substring to look for, e.g. deploy"
            }
            className="text-xs"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={caseInsensitive}
              onChange={(e) => {
                // Toggle only the `i` flag, preserving any other valid flag
                // (e.g. `m`) instead of overwriting the whole string.
                const withoutI = (condition.value.flags ?? "").replace(/i/g, "");
                const nextFlags = e.target.checked ? `${withoutI}i` : withoutI;
                onChange({
                  ...condition,
                  value: { ...condition.value, flags: nextFlags || undefined },
                });
              }}
            />
            Case-insensitive
          </label>
        </div>
      );
    }
    case "slack_channel":
      return (
        <SlackChannelPicker
          values={condition.value}
          onChange={(value) => onChange({ ...condition, value })}
        />
      );
    case "slack_actor":
      return (
        <div className="space-y-2">
          <Select
            value={condition.operator}
            onValueChange={(v) => onChange({ ...condition, operator: v as "include" | "exclude" })}
          >
            <SelectTrigger className="w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="include">include</SelectItem>
              <SelectItem value="exclude">exclude</SelectItem>
            </SelectContent>
          </Select>
          <TagInput
            values={condition.value}
            onChange={(value) => onChange({ ...condition, value })}
            placeholder="Add Slack user ID (e.g. U0123ABCD)..."
          />
        </div>
      );
    default:
      return <div className="text-xs text-muted-foreground">Configuration not available</div>;
  }
}

/**
 * Channel selector for the `slack_channel` condition. Resolves channel names
 * from the workspace listing and stores channel IDs. Falls back to manual ID
 * entry when the listing is unavailable (no bot token, missing scopes, or a
 * Slack API failure), so the condition is always editable.
 */
function SlackChannelPicker({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const { channels, loading } = useSlackChannels();
  const byId = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);

  const add = (id: string) => {
    const trimmed = id.trim();
    if (trimmed && !values.includes(trimmed)) onChange([...values, trimmed]);
  };
  const remove = (id: string) => onChange(values.filter((v) => v !== id));

  // Degraded mode: no channel list (no bot token, missing scopes, or empty
  // workspace). Fall back to manual channel-ID entry so the trigger still works.
  if (!loading && channels.length === 0) {
    return (
      <div className="space-y-2">
        <TagInput
          values={values}
          onChange={onChange}
          placeholder="Add channel ID (e.g. C0123ABCD)..."
        />
        <p className="text-xs text-muted-foreground">
          Couldn&apos;t list Slack channels — add channel IDs manually. Check that the Slack app has
          the <code>channels:read</code> / <code>groups:read</code> scopes and that the bot is
          invited to the channel.
        </p>
      </div>
    );
  }

  // Unselected channels, bot-member first, then alphabetical.
  const options: ComboboxOption[] = channels
    .filter((c) => !values.includes(c.id))
    .sort((a, b) => Number(b.isMember) - Number(a.isMember) || a.name.localeCompare(b.name))
    .map((c) => ({
      value: c.id,
      label: `#${c.name}`,
      description: !c.isMember ? "bot not in channel" : c.isPrivate ? "private" : undefined,
    }));
  const someNotMember = values.some((id) => byId.get(id)?.isMember === false);

  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((id) => {
            const ch = byId.get(id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-muted text-foreground rounded"
              >
                {ch ? `#${ch.name}` : id}
                <button
                  type="button"
                  onClick={() => remove(id)}
                  aria-label={`Remove ${ch ? ch.name : id}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      <Combobox
        value=""
        onChange={add}
        items={options}
        searchable
        searchPlaceholder="Search channels..."
        dropdownWidth="w-64"
        disabled={loading}
        triggerClassName="flex w-56 items-center gap-1.5 px-3 py-2 text-xs border border-border bg-input text-foreground hover:border-foreground/20 transition"
      >
        <span className="truncate flex-1 text-left">
          {loading ? "Loading channels..." : "Add channel..."}
        </span>
        <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
      </Combobox>
      {someNotMember && (
        <p className="text-xs text-warning">
          The bot isn&apos;t a member of some selected channels and won&apos;t receive their
          messages until it&apos;s invited.
        </p>
      )}
    </div>
  );
}

function TagInput({
  values,
  onChange,
  placeholder,
  suggestions,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  suggestions?: string[];
}) {
  const [input, setInput] = useState("");

  const addValue = () => {
    const trimmed = input.trim();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
      setInput("");
    }
  };

  const removeValue = (value: string) => {
    onChange(values.filter((v) => v !== value));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-muted text-foreground rounded"
          >
            {v}
            <button
              type="button"
              onClick={() => removeValue(v)}
              aria-label={`Remove ${v}`}
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        {suggestions ? (
          <Select
            value=""
            onValueChange={(v) => {
              if (!values.includes(v)) onChange([...values, v]);
            }}
          >
            <SelectTrigger className="w-48 text-xs">
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {suggestions
                .filter((s) => !values.includes(s))
                .map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addValue();
              }
            }}
            placeholder={placeholder}
            className="text-xs"
          />
        )}
      </div>
    </div>
  );
}

function JsonPathEditor({
  filters,
  onChange,
}: {
  filters: JsonPathFilter[];
  onChange: (filters: JsonPathFilter[]) => void;
}) {
  const updateFilter = (index: number, updated: JsonPathFilter) => {
    const newFilters = [...filters];
    newFilters[index] = updated;
    onChange(newFilters);
  };

  const removeFilter = (index: number) => {
    onChange(filters.filter((_, i) => i !== index));
  };

  const addFilter = () => {
    onChange([...filters, { path: "$.", comparison: "eq", value: "" }]);
  };

  return (
    <div className="space-y-2">
      {filters.map((filter, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            type="text"
            value={filter.path}
            onChange={(e) => updateFilter(index, { ...filter, path: e.target.value })}
            placeholder="$.path.to.field"
            className="text-xs w-40"
          />
          <Select
            value={filter.comparison}
            onValueChange={(v) =>
              updateFilter(index, { ...filter, comparison: v as JsonPathFilter["comparison"] })
            }
          >
            <SelectTrigger className="w-24 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="eq">=</SelectItem>
              <SelectItem value="neq">!=</SelectItem>
              <SelectItem value="gt">&gt;</SelectItem>
              <SelectItem value="gte">&gt;=</SelectItem>
              <SelectItem value="lt">&lt;</SelectItem>
              <SelectItem value="lte">&lt;=</SelectItem>
              <SelectItem value="contains">contains</SelectItem>
              <SelectItem value="exists">exists</SelectItem>
            </SelectContent>
          </Select>
          {filter.comparison !== "exists" && (
            <Input
              type="text"
              value={String(filter.value ?? "")}
              onChange={(e) => {
                const val = e.target.value;
                const numVal = Number(val);
                updateFilter(index, {
                  ...filter,
                  value: !isNaN(numVal) && val !== "" ? numVal : val,
                });
              }}
              placeholder="value"
              className="text-xs w-32"
            />
          )}
          <Button type="button" variant="ghost" size="xs" onClick={() => removeFilter(index)}>
            x
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="xs" onClick={addFilter}>
        Add filter
      </Button>
    </div>
  );
}
