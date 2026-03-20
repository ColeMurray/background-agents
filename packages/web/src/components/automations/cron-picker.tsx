"use client";

import { useState, useMemo } from "react";
import { isValidCron, nextCronOccurrence, describeCron } from "@open-inspect/shared";
import { RadioCard } from "@/components/ui/form-controls";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { detectPreset, buildCron, type PresetType } from "@/lib/cron-presets";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAYS_OF_WEEK = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];
const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, i) => i + 1);

function formatHour(hour: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:00 ${suffix}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

interface CronPickerProps {
  value: string;
  onChange: (cron: string) => void;
  timezone: string;
}

export function CronPicker({ value, onChange, timezone }: CronPickerProps) {
  const detected = useMemo(() => detectPreset(value), [value]);
  const [presetType, setPresetType] = useState<PresetType>(detected.type);
  const [hour, setHour] = useState(detected.hour);
  const [dayOfWeek, setDayOfWeek] = useState(detected.dayOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(detected.dayOfMonth);
  const [customValue, setCustomValue] = useState(presetType === "custom" ? value : "");

  const handlePresetChange = (type: PresetType) => {
    setPresetType(type);
    if (type !== "custom") {
      onChange(buildCron(type, hour, dayOfWeek, dayOfMonth));
    } else {
      setCustomValue(value);
    }
  };

  const handleHourChange = (newHour: number) => {
    setHour(newHour);
    if (presetType !== "custom") {
      onChange(buildCron(presetType, newHour, dayOfWeek, dayOfMonth));
    }
  };

  const handleDayOfWeekChange = (newDay: string) => {
    setDayOfWeek(newDay);
    if (presetType === "weekly") {
      onChange(buildCron("weekly", hour, newDay, dayOfMonth));
    }
  };

  const handleDayOfMonthChange = (newDay: number) => {
    setDayOfMonth(newDay);
    if (presetType === "monthly") {
      onChange(buildCron("monthly", hour, dayOfWeek, newDay));
    }
  };

  const handleCustomChange = (cron: string) => {
    setCustomValue(cron);
    onChange(isValidCron(cron) ? cron : "");
  };

  const isValid = isValidCron(value);
  const nextRun = isValid ? nextCronOccurrence(value, timezone) : null;
  const description = isValid ? describeCron(value, timezone) : null;

  const showTimeSelector =
    presetType === "daily" || presetType === "weekly" || presetType === "monthly";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <RadioCard
          name="cron-preset"
          value="hourly"
          label="Every hour"
          checked={presetType === "hourly"}
          onChange={() => handlePresetChange("hourly")}
        />
        <RadioCard
          name="cron-preset"
          value="daily"
          label="Daily"
          checked={presetType === "daily"}
          onChange={() => handlePresetChange("daily")}
        />
        <RadioCard
          name="cron-preset"
          value="weekly"
          label="Weekly"
          checked={presetType === "weekly"}
          onChange={() => handlePresetChange("weekly")}
        />
        <RadioCard
          name="cron-preset"
          value="monthly"
          label="Monthly"
          checked={presetType === "monthly"}
          onChange={() => handlePresetChange("monthly")}
        />
        <RadioCard
          name="cron-preset"
          value="custom"
          label="Custom"
          checked={presetType === "custom"}
          onChange={() => handlePresetChange("custom")}
          className="col-span-2"
        />
      </div>

      {showTimeSelector && (
        <div className="flex items-center gap-3">
          {presetType === "weekly" && (
            <Select value={dayOfWeek} onValueChange={handleDayOfWeekChange}>
              <SelectTrigger density="compact" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS_OF_WEEK.map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {presetType === "monthly" && (
            <Select
              value={String(dayOfMonth)}
              onValueChange={(v) => handleDayOfMonthChange(parseInt(v))}
            >
              <SelectTrigger density="compact" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS_OF_MONTH.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {ordinal(d)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <span className="text-sm text-muted-foreground">at</span>
          <Select value={String(hour)} onValueChange={(v) => handleHourChange(parseInt(v))}>
            <SelectTrigger density="compact" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((h) => (
                <SelectItem key={h} value={String(h)}>
                  {formatHour(h)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {presetType === "custom" && (
        <div>
          <Input
            value={customValue}
            onChange={(e) => handleCustomChange(e.target.value)}
            placeholder="0 9 * * 1-5"
            className="font-mono placeholder:text-secondary-foreground"
          />
          {customValue && !isValidCron(customValue) && (
            <p className="mt-1 text-xs text-red-500">
              Invalid cron expression. Use 5-field format (minute hour day month weekday).
            </p>
          )}
        </div>
      )}

      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {nextRun && (
        <p className="text-xs text-muted-foreground">Next run: {nextRun.toLocaleString()}</p>
      )}
    </div>
  );
}
