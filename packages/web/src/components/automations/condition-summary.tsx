"use client";

import { useMemo } from "react";
import type { TriggerCondition } from "@open-inspect/shared";
import { useSlackChannels } from "@/hooks/use-slack-channels";

/**
 * Render a human-readable value for one trigger condition.
 *
 * Slack channel IDs resolve to `#name` (falling back to the raw ID when the
 * channel can't be listed), and structured values (`text_match`, `jsonpath`)
 * are formatted explicitly instead of stringifying to "[object Object]".
 */
function formatConditionValue(
  condition: TriggerCondition,
  channelNameById: Map<string, string>
): string {
  switch (condition.type) {
    case "slack_channel":
      return condition.value
        .map((id) => {
          const name = channelNameById.get(id);
          return name ? `#${name}` : id;
        })
        .join(", ");
    case "text_match": {
      const { pattern, flags } = condition.value;
      return flags ? `${pattern} (${flags})` : pattern;
    }
    case "jsonpath":
      return condition.value
        .map((f) => `${f.path} ${f.comparison}${f.value === undefined ? "" : ` ${f.value}`}`)
        .join(", ");
    default:
      return Array.isArray(condition.value) ? condition.value.join(", ") : String(condition.value);
  }
}

/**
 * Read-only summary of an automation's trigger conditions, shown on the detail
 * page. Resolves Slack channel names lazily — only when a `slack_channel`
 * condition is present.
 */
export function ConditionSummary({ conditions }: { conditions: TriggerCondition[] }) {
  const hasSlackChannel = conditions.some((c) => c.type === "slack_channel");
  const { channels } = useSlackChannels(hasSlackChannel);
  const channelNameById = useMemo(() => new Map(channels.map((c) => [c.id, c.name])), [channels]);

  return (
    <div className="sm:col-span-2">
      <dt className="text-muted-foreground">Conditions</dt>
      <dd className="text-foreground">
        {conditions.map((c, i) => (
          <span key={i} className="inline-block mr-2 mb-1 px-2 py-0.5 bg-muted rounded text-xs">
            {c.type}: {c.operator} {formatConditionValue(c, channelNameById)}
          </span>
        ))}
      </dd>
    </div>
  );
}
