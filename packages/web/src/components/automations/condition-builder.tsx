"use client";

import { useState } from "react";
import type { TriggerCondition, AutomationEventSource, JsonPathFilter } from "@open-inspect/shared";
import { conditionRegistry } from "@open-inspect/shared";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ConditionBuilderProps {
  conditions: TriggerCondition[];
  onChange: (conditions: TriggerCondition[]) => void;
  triggerSource: AutomationEventSource;
}

const CONDITION_LABELS: Record<string, string> = {
  sentry_project: "Sentry Project",
  sentry_level: "Error Level",
  jsonpath: "JSONPath Filter",
  branch: "Branch",
  label: "Label",
  path_glob: "Path Glob",
  actor: "Actor",
  check_conclusion: "Check Conclusion",
  linear_status: "Linear Status",
};

const SENTRY_LEVELS = ["warning", "error", "fatal"];

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
          className="flex items-start gap-2 p-3 border border-border-muted rounded-md bg-background"
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
    default:
      return <div className="text-xs text-muted-foreground">Configuration not available</div>;
  }
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
              className="text-muted-foreground hover:text-foreground"
            >
              x
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
