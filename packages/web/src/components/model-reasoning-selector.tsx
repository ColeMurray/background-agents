"use client";

import { Fragment, useState } from "react";
import {
  getReasoningConfig,
  type ModelCategory,
  type ReasoningEffort,
  type ValidModel,
} from "@open-inspect/shared/models";
import {
  HARNESS_IDS,
  getHarnessLabel,
  isValidHarness,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import { formatModelNameLower } from "@/lib/format";
import { BackIcon, ChevronDownIcon } from "@/components/ui/icons";
import { HarnessIcon, HarnessName } from "@/components/harness-icon";
import { useIsMobile } from "@/hooks/use-media-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ModelReasoningSelectorProps = {
  selectedModel: ValidModel;
  reasoningEffort: ReasoningEffort | undefined;
  items: ModelCategory[];
  onModelChange: (model: ValidModel) => void;
  onReasoningEffortChange: (effort: ReasoningEffort | undefined) => void;
  /** Agent harness shown as the trigger's prefix. */
  harness?: HarnessId;
  /** Adds an Agent row to the menu; leave unset once the session's harness is fixed. */
  onHarnessChange?: (harness: HarnessId) => void;
  disabled?: boolean;
};

const DEFAULT_EFFORT_VALUE = "__default__";

function formatEffort(effort: string): string {
  return effort === "xhigh" ? "XHigh" : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}

export function ModelReasoningSelector({
  selectedModel,
  reasoningEffort,
  items,
  onModelChange,
  onReasoningEffortChange,
  harness,
  onHarnessChange,
  disabled = false,
}: ModelReasoningSelectorProps) {
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<"main" | "agent" | "model" | "effort">("main");
  const reasoningConfig = getReasoningConfig(selectedModel);
  const selectedEffort = reasoningEffort ?? reasoningConfig?.default;
  const effortLabel = selectedEffort ? formatEffort(selectedEffort) : "Default";
  const modelLabel = formatModelNameLower(selectedModel);
  const harnessLabel = harness ? getHarnessLabel(harness) : null;
  const canChangeHarness = harness !== undefined && onHarnessChange !== undefined;
  const triggerLabel = [
    harnessLabel ? `Agent, model and effort: ${harnessLabel}` : "Model and effort:",
    modelLabel,
    ...(reasoningConfig ? [effortLabel] : []),
  ].join(", ");

  return (
    <DropdownMenu onOpenChange={(open) => !open && setMobileView("main")}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={triggerLabel}
        >
          {harness && harnessLabel && (
            <>
              <HarnessIcon harness={harness} className="size-3.5" />
              <span className="hidden shrink-0 sm:inline">{harnessLabel}:</span>
            </>
          )}
          <span className="max-w-[9rem] truncate sm:max-w-none">{modelLabel}</span>
          {reasoningConfig && (
            <span className="shrink-0 text-secondary-foreground">{effortLabel}</span>
          )}
          <ChevronDownIcon className="size-3.5 shrink-0 text-secondary-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        collisionPadding={8}
        className={`w-64 max-w-[calc(100vw-2rem)] ${isMobile && mobileView !== "main" ? "overflow-y-auto" : ""}`}
        style={
          isMobile && mobileView !== "main"
            ? {
                maxHeight: "min(14rem, var(--radix-dropdown-menu-content-available-height))",
              }
            : undefined
        }
      >
        {isMobile ? (
          mobileView === "main" ? (
            <>
              {canChangeHarness && (
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    setMobileView("agent");
                  }}
                >
                  <span>Agent</span>
                  <span className="ml-auto max-w-32 truncate text-muted-foreground">
                    {harnessLabel}
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setMobileView("model");
                }}
              >
                <span>Model</span>
                <span className="ml-auto max-w-32 truncate text-muted-foreground">
                  {modelLabel}
                </span>
              </DropdownMenuItem>
              {reasoningConfig && (
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    setMobileView("effort");
                  }}
                >
                  <span>Effort</span>
                  <span className="ml-auto text-muted-foreground">{effortLabel}</span>
                </DropdownMenuItem>
              )}
            </>
          ) : (
            <>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setMobileView("main");
                }}
              >
                <BackIcon />
                Back
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {mobileView === "agent" && harness && onHarnessChange ? (
                <HarnessOptions value={harness} onChange={onHarnessChange} />
              ) : mobileView === "model" ? (
                <ModelOptions items={items} value={selectedModel} onChange={onModelChange} />
              ) : (
                reasoningConfig && (
                  <EffortOptions
                    efforts={reasoningConfig.efforts}
                    value={reasoningEffort}
                    onChange={onReasoningEffortChange}
                  />
                )
              )}
            </>
          )
        ) : (
          <>
            {canChangeHarness && harness && onHarnessChange && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <span>Agent</span>
                  <span className="ml-auto max-w-32 truncate text-muted-foreground">
                    {harnessLabel}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent align="end" collisionPadding={8} className="w-48">
                  <HarnessOptions value={harness} onChange={onHarnessChange} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span>Model</span>
                <span className="ml-auto max-w-32 truncate text-muted-foreground">
                  {modelLabel}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                align="end"
                collisionPadding={8}
                className="max-h-56 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto"
              >
                <ModelOptions items={items} value={selectedModel} onChange={onModelChange} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {reasoningConfig && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <span>Effort</span>
                  <span className="ml-auto text-muted-foreground">{effortLabel}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent align="end" collisionPadding={8} className="w-40">
                  <EffortOptions
                    efforts={reasoningConfig.efforts}
                    value={reasoningEffort}
                    onChange={onReasoningEffortChange}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HarnessOptions({
  value,
  onChange,
}: {
  value: HarnessId;
  onChange: (harness: HarnessId) => void;
}) {
  return (
    <DropdownMenuRadioGroup
      value={value}
      onValueChange={(next) => {
        if (isValidHarness(next)) onChange(next);
      }}
    >
      {HARNESS_IDS.map((candidate) => (
        <DropdownMenuRadioItem key={candidate} value={candidate}>
          <HarnessName harness={candidate} />
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

function ModelOptions({
  items,
  value,
  onChange,
}: {
  items: ModelCategory[];
  value: ValidModel;
  onChange: (model: ValidModel) => void;
}) {
  return (
    <DropdownMenuRadioGroup
      value={value}
      onValueChange={(nextValue) => {
        const model = items.flatMap((group) => group.models).find(({ id }) => id === nextValue);
        if (model) onChange(model.id);
      }}
    >
      {items.map((group, groupIndex) => (
        <Fragment key={group.category}>
          {groupIndex > 0 && <DropdownMenuSeparator />}
          <DropdownMenuLabel className="text-xs uppercase tracking-wider text-secondary-foreground">
            {group.category}
          </DropdownMenuLabel>
          {group.models.map((model) => (
            <DropdownMenuRadioItem key={model.id} value={model.id}>
              <span className="min-w-0">
                <span className="block truncate">{model.name}</span>
                {model.description && (
                  <span className="block truncate text-xs text-secondary-foreground">
                    {model.description}
                  </span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </Fragment>
      ))}
    </DropdownMenuRadioGroup>
  );
}

function EffortOptions({
  efforts,
  value,
  onChange,
}: {
  efforts: readonly ReasoningEffort[];
  value: ReasoningEffort | undefined;
  onChange: (effort: ReasoningEffort | undefined) => void;
}) {
  return (
    <DropdownMenuRadioGroup
      value={value ?? DEFAULT_EFFORT_VALUE}
      onValueChange={(nextValue) => {
        if (nextValue === DEFAULT_EFFORT_VALUE) {
          onChange(undefined);
          return;
        }
        const effort = efforts.find((candidate) => candidate === nextValue);
        if (effort) onChange(effort);
      }}
    >
      <DropdownMenuRadioItem value={DEFAULT_EFFORT_VALUE}>Default</DropdownMenuRadioItem>
      {efforts.map((effort) => (
        <DropdownMenuRadioItem key={effort} value={effort}>
          {formatEffort(effort)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
