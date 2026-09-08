"use client";

import { useState } from "react";
import {
  dedupeConditionsBySemanticKey,
  isGitHubConditionCompatible,
  triggerSources,
  TRIGGER_TYPE_TO_SOURCE,
  type AutomationEventSource,
  type AutomationTriggerType,
  type TriggerCondition,
} from "@open-inspect/shared/triggers";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronDownIcon } from "@/components/ui/icons";
import { ConditionBuilder } from "./condition-builder";
import { CONDITION_LABELS } from "./condition-labels";
import { CronPicker } from "./cron-picker";
import { FieldDescription } from "./automation-form-field";
import { TriggerTypeSelector } from "./trigger-type-selector";
import type { AutomationFormMode, AutomationTriggerDraft } from "./automation-form-policy";
import { transitionAutomationTriggerType } from "./automation-form-policy";

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
];
const COMMON_SET = new Set(COMMON_TIMEZONES);
const ALL_TIMEZONES = Intl.supportedValuesOf("timeZone");
const TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  schedule: "Schedule",
  sentry: "Sentry Alert",
  webhook: "Inbound Webhook",
  github_event: "GitHub Event",
  linear_event: "Linear Event",
  slack_event: "Slack Message",
};

const toOption = (timezone: string) => ({
  value: timezone,
  label: timezone.replace(/_/g, " "),
});

const TIMEZONE_GROUPS: ComboboxGroup[] = [
  { category: "Common", options: COMMON_TIMEZONES.map(toOption) },
  {
    category: "All Timezones",
    options: ALL_TIMEZONES.filter((timezone) => !COMMON_SET.has(timezone)).map(toOption),
  },
];

interface AutomationTriggerFieldsProps {
  mode: AutomationFormMode;
  value: AutomationTriggerDraft;
  onChange: (value: AutomationTriggerDraft) => void;
}

interface AutomationTriggerConfigurationFieldsProps extends AutomationTriggerFieldsProps {
  eventTypeError: string;
  slackChannelError: string;
  conditionErrors: string[];
}

export function AutomationTriggerTypeField({
  mode,
  value,
  onChange,
}: AutomationTriggerFieldsProps) {
  const changeTriggerType = (nextType: AutomationTriggerType) => {
    onChange(transitionAutomationTriggerType(value, nextType));
  };

  return (
    <div>
      <div
        id="automation-trigger-type-label"
        className="block text-sm font-medium text-foreground mb-1.5"
      >
        Trigger Type
      </div>
      {mode === "create" ? (
        <>
          <FieldDescription className="my-1">
            Scheduled automations run on a repeating timer. Other types run when the connected
            service sends an event (for example a GitHub webhook or Sentry alert).
          </FieldDescription>
          <TriggerTypeSelector
            value={value.type}
            onChange={changeTriggerType}
            labelledBy="automation-trigger-type-label"
          />
        </>
      ) : (
        <>
          <div className="text-sm text-muted-foreground px-3 py-2 border border-border-muted rounded-md bg-muted/30">
            {TRIGGER_LABELS[value.type]}
            <span className="text-xs ml-2">(cannot be changed)</span>
          </div>
          <FieldDescription>
            Trigger type is fixed after the automation is created. Create a new automation to use a
            different trigger.
          </FieldDescription>
        </>
      )}
    </div>
  );
}

export function AutomationTriggerConfigurationFields({
  mode,
  value,
  onChange,
  eventTypeError,
  slackChannelError,
  conditionErrors,
}: AutomationTriggerConfigurationFieldsProps) {
  const [droppedConditions, setDroppedConditions] = useState<TriggerCondition[]>([]);
  const source = triggerSources.find((candidate) => candidate.triggerType === value.type);
  const eventTypes = source?.eventTypes ?? [];
  const showEventTypeSelector = Boolean(source?.supportsEventTypes && eventTypes.length > 0);
  const eventTypePlaceholder = source?.eventTypePlaceholder || "Select event type...";
  const isSchedule = value.type === "schedule";

  const update = (changes: Partial<AutomationTriggerDraft>) => {
    onChange({ ...value, ...changes });
  };

  const changeEventType = (eventType: string) => {
    if (TRIGGER_TYPE_TO_SOURCE[value.type] !== "github") {
      setDroppedConditions([]);
      update({ eventType });
      return;
    }
    const candidates = dedupeConditionsBySemanticKey([...value.conditions, ...droppedConditions]);
    const conditions = candidates.filter((condition) =>
      isGitHubConditionCompatible(eventType, condition)
    );
    setDroppedConditions(candidates.filter((condition) => !conditions.includes(condition)));
    update({ eventType, conditions });
  };

  return (
    <>
      {isSchedule && (
        <>
          <fieldset>
            <legend className="block text-sm font-medium text-foreground mb-1.5">Schedule</legend>
            <CronPicker
              value={value.scheduleCron}
              onChange={(scheduleCron) => update({ scheduleCron })}
              timezone={value.scheduleTz}
            />
            <FieldDescription>
              How often this automation runs. Use a preset or a five-field cron expression (minute,
              hour, day of month, month, day of week).
            </FieldDescription>
          </fieldset>
          <div>
            <label
              id="automation-timezone-label"
              htmlFor="automation-timezone"
              className="block text-sm font-medium text-foreground mb-1.5"
            >
              Timezone
            </label>
            <Combobox
              id="automation-timezone"
              labelId="automation-timezone-label"
              value={value.scheduleTz}
              onChange={(scheduleTz) => update({ scheduleTz })}
              items={TIMEZONE_GROUPS}
              maxDisplayed={20}
              searchable
              searchPlaceholder="Search timezones..."
              filterFn={(option, query) =>
                option.label.toLowerCase().includes(query) ||
                String(option.value).toLowerCase().includes(query)
              }
              dropdownWidth="w-64"
              triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
            >
              <span className="truncate flex-1 text-left">
                {value.scheduleTz.replace(/_/g, " ")}
              </span>
              <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
            </Combobox>
            <FieldDescription>
              The schedule is evaluated in this time zone (for example, &quot;9:00&quot; is 9:00
              local time here).
            </FieldDescription>
          </div>
        </>
      )}

      {showEventTypeSelector && (
        <div>
          <label
            htmlFor="automation-event-type"
            className="block text-sm font-medium text-foreground mb-1.5"
          >
            Event Type
          </label>
          <Select value={value.eventType} onValueChange={changeEventType}>
            <SelectTrigger id="automation-event-type" className="w-full">
              <SelectValue placeholder={eventTypePlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {eventTypes.map((eventType) => (
                <SelectItem key={eventType.eventType} value={eventType.eventType}>
                  {eventType.displayName}
                  <span className="text-muted-foreground ml-2 text-xs">
                    {eventType.description}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            Only events of this type on the selected repository can start a run for this automation.
          </FieldDescription>
          {eventTypeError && <p className="mt-1 text-xs text-destructive">{eventTypeError}</p>}
        </div>
      )}

      {value.type === "sentry" && mode === "create" && (
        <div>
          <label
            htmlFor="sentry-client-secret"
            className="block text-sm font-medium text-foreground mb-1.5"
          >
            Sentry Client Secret
          </label>
          <Input
            id="sentry-client-secret"
            type="password"
            value={value.sentryClientSecret}
            onChange={(event) => update({ sentryClientSecret: event.target.value })}
            placeholder="Paste your Sentry Custom Integration client secret"
            required
          />
          <p className="text-xs text-muted-foreground mt-1">
            Found in your Sentry Custom Integration settings. This will be encrypted and stored
            securely.
          </p>
        </div>
      )}

      {!isSchedule && TRIGGER_TYPE_TO_SOURCE[value.type] && (
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="block text-sm font-medium text-foreground mb-1.5">
            Conditions
            <span className="text-xs text-muted-foreground ml-1 font-normal">(optional)</span>
          </legend>
          <ConditionBuilder
            conditions={value.conditions}
            onChange={(conditions) => update({ conditions })}
            triggerSource={TRIGGER_TYPE_TO_SOURCE[value.type] as AutomationEventSource}
            eventType={value.eventType || undefined}
          />
          <FieldDescription>
            Optional filters on incoming events. When you add conditions, every condition must pass
            before a run starts.
          </FieldDescription>
          {droppedConditions.length > 0 && (
            <FieldDescription>
              <span role="status">
                Removed{" "}
                {droppedConditions.map(({ type }) => CONDITION_LABELS[type] || type).join(", ")} —
                not available for this event type.
              </span>
            </FieldDescription>
          )}
          {conditionErrors.map((conditionError, index) => (
            <p key={`${conditionError}-${index}`} className="mt-1 text-xs text-destructive">
              {conditionError}
            </p>
          ))}
          {slackChannelError && (
            <p className="mt-1 text-xs text-destructive">{slackChannelError}</p>
          )}
        </fieldset>
      )}
    </>
  );
}
