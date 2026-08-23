"use client";

import { Fragment, useState } from "react";
import {
  getReasoningConfig,
  type ModelCategory,
  type ReasoningEffort,
  type ValidModel,
} from "@open-inspect/shared/models";
import { formatModelNameLower } from "@/lib/format";
import { BackIcon, ChevronDownIcon, ModelIcon } from "@/components/ui/icons";
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
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
};

function formatEffort(effort: string): string {
  return effort === "xhigh" ? "XHigh" : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}

export function ModelReasoningSelector({
  selectedModel,
  reasoningEffort,
  items,
  onModelChange,
  onReasoningEffortChange,
  disabled = false,
}: ModelReasoningSelectorProps) {
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<"main" | "model" | "effort">("main");
  const reasoningConfig = getReasoningConfig(selectedModel);
  const selectedEffort = reasoningEffort ?? reasoningConfig?.default;
  const modelLabel = formatModelNameLower(selectedModel);

  return (
    <DropdownMenu onOpenChange={(open) => !open && setMobileView("main")}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Model and effort: ${modelLabel}${selectedEffort ? `, ${selectedEffort}` : ""}`}
        >
          <ModelIcon className="size-3.5 shrink-0" />
          <span className="max-w-[9rem] truncate sm:max-w-none">{modelLabel}</span>
          {selectedEffort && (
            <span className="shrink-0 text-secondary-foreground">
              {formatEffort(selectedEffort)}
            </span>
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
              {reasoningConfig && selectedEffort && (
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    setMobileView("effort");
                  }}
                >
                  <span>Effort</span>
                  <span className="ml-auto text-muted-foreground">
                    {formatEffort(selectedEffort)}
                  </span>
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
              {mobileView === "model" ? (
                <ModelOptions items={items} value={selectedModel} onChange={onModelChange} />
              ) : (
                reasoningConfig &&
                selectedEffort && (
                  <EffortOptions
                    efforts={reasoningConfig.efforts}
                    value={selectedEffort}
                    onChange={onReasoningEffortChange}
                  />
                )
              )}
            </>
          )
        ) : (
          <>
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
            {reasoningConfig && selectedEffort && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <span>Effort</span>
                  <span className="ml-auto text-muted-foreground">
                    {formatEffort(selectedEffort)}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent align="end" collisionPadding={8} className="w-40">
                  <EffortOptions
                    efforts={reasoningConfig.efforts}
                    value={selectedEffort}
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
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
}) {
  return (
    <DropdownMenuRadioGroup
      value={value}
      onValueChange={(nextValue) => {
        const effort = efforts.find((candidate) => candidate === nextValue);
        if (effort) onChange(effort);
      }}
    >
      {efforts.map((effort) => (
        <DropdownMenuRadioItem key={effort} value={effort}>
          {formatEffort(effort)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
