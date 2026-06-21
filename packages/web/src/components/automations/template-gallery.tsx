"use client";

import { useState } from "react";
import Link from "next/link";
import type { AutomationTriggerType } from "@open-inspect/shared";
import {
  automationTemplates,
  getVisibleCategories,
  type AutomationTemplate,
  type TemplateCategory,
} from "@/lib/automation-templates";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  ClockIcon,
  GitHubIcon,
  GitPrIcon,
  GlobeIcon,
  SentryIcon,
  SlackIcon,
} from "@/components/ui/icons";

const ICON_CLASS = "w-4 h-4 flex-shrink-0";

const TRIGGER_LABELS: Record<string, string> = {
  schedule: "Schedule",
  github_event: "GitHub event",
  sentry: "Sentry",
  webhook: "Webhook",
  linear_event: "Linear",
};

const OUTPUT_LABELS: Record<AutomationTemplate["primaryOutput"], string> = {
  pr: "Pull request",
  slack: "Slack",
};

function TriggerIcon({ type }: { type?: AutomationTriggerType }) {
  switch (type) {
    case "github_event":
      return <GitHubIcon className={ICON_CLASS} />;
    case "sentry":
      return <SentryIcon className={ICON_CLASS} />;
    case "webhook":
      return <GlobeIcon className={ICON_CLASS} />;
    case "schedule":
    default:
      return <ClockIcon className={ICON_CLASS} />;
  }
}

function OutputIcon({ output }: { output: AutomationTemplate["primaryOutput"] }) {
  return output === "slack" ? (
    <SlackIcon className={ICON_CLASS} />
  ) : (
    <GitPrIcon className={ICON_CLASS} />
  );
}

function TemplateCard({ template }: { template: AutomationTemplate }) {
  const triggerLabel = TRIGGER_LABELS[template.prefill.triggerType ?? "schedule"] ?? "Schedule";
  const outputLabel = OUTPUT_LABELS[template.primaryOutput];

  return (
    <div
      data-template-id={template.id}
      className="flex flex-col rounded-md border border-border-muted bg-card p-4"
    >
      <div className="flex items-center text-muted-foreground">
        <span
          className="flex items-center gap-1.5"
          aria-hidden="true"
          title={`${triggerLabel} → ${outputLabel}`}
        >
          <TriggerIcon type={template.prefill.triggerType} />
          <span className="text-xs">—</span>
          <OutputIcon output={template.primaryOutput} />
        </span>
        <span className="sr-only">
          Trigger: {triggerLabel}. Output: {outputLabel}.
        </span>
      </div>

      <h3 className="mt-3 font-medium text-foreground">{template.title}</h3>
      <p className="mt-1 flex-1 text-sm text-muted-foreground leading-normal">
        {template.description}
      </p>

      {template.setupNote && (
        <p className="mt-2 text-xs text-muted-foreground/80 leading-normal">{template.setupNote}</p>
      )}

      <div className="mt-3">
        <Button variant="outline" size="sm" asChild>
          <Link
            href={`/automations/new?template=${template.id}`}
            aria-label={`Add ${template.title}`}
          >
            Add
          </Link>
        </Button>
      </div>
    </div>
  );
}

export function TemplateGallery() {
  const categories = getVisibleCategories();
  const [category, setCategory] = useState<TemplateCategory>(categories[0]?.id ?? "popular");

  const activeLabel = categories.find((c) => c.id === category)?.label ?? "";
  const templates = automationTemplates.filter((t) => t.categories.includes(category));

  return (
    <div>
      <ToggleGroup
        type="single"
        value={category}
        onValueChange={(value) => {
          // Radix emits "" when the active item is re-clicked; keep the selection.
          if (value) setCategory(value as TemplateCategory);
        }}
        variant="outline"
        size="sm"
        aria-label="Filter templates by category"
        className="flex flex-wrap justify-start gap-1 rounded-md bg-card p-1"
      >
        {categories.map((c) => (
          <ToggleGroupItem key={c.id} value={c.id} data-testid={`category-${c.id}`}>
            {c.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {/* Visually-hidden heading fills the h1 → h3 gap for assistive tech. */}
      <h2 className="sr-only">{activeLabel} templates</h2>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {templates.map((template) => (
          <TemplateCard key={template.id} template={template} />
        ))}
      </div>
    </div>
  );
}
