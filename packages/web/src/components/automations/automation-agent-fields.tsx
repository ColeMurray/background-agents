"use client";

import {
  getReasoningConfig,
  isValidReasoningEffort,
  type ModelCategory,
} from "@open-inspect/shared/models";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronDownIcon, ModelIcon } from "@/components/ui/icons";
import { formatModelNameLower } from "@/lib/format";
import { FieldDescription } from "./automation-form-field";
import type { AutomationAgentDraft } from "./automation-form-policy";

const DEFAULT_REASONING_VALUE = "__default__";

interface AutomationAgentFieldsProps {
  value: AutomationAgentDraft;
  resolvedModel: string;
  enabledModelOptions: ModelCategory[];
  onChange: (value: AutomationAgentDraft) => void;
}

export function AutomationAgentFields({
  value,
  resolvedModel,
  enabledModelOptions,
  onChange,
}: AutomationAgentFieldsProps) {
  const reasoningConfig = getReasoningConfig(resolvedModel);
  const modelGroups: ComboboxGroup[] = enabledModelOptions.map((group) => ({
    category: group.category,
    options: group.models.map((model) => ({
      value: model.id,
      label: model.name,
      description: model.description,
    })),
  }));

  const changeModel = (model: string) => {
    const reasoningEffort =
      value.reasoningEffort && isValidReasoningEffort(model, value.reasoningEffort)
        ? value.reasoningEffort
        : "";
    onChange({ model, reasoningEffort });
  };

  return (
    <>
      <div>
        <label
          id="automation-model-label"
          htmlFor="automation-model"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Model
        </label>
        <Combobox
          id="automation-model"
          labelId="automation-model-label"
          value={resolvedModel}
          onChange={changeModel}
          items={modelGroups}
          dropdownWidth="w-56"
          triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
        >
          <ModelIcon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="truncate flex-1 text-left">{formatModelNameLower(resolvedModel)}</span>
          <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
        </Combobox>
        <FieldDescription>
          Model used for the agent on each run of this automation.
        </FieldDescription>
      </div>

      <div>
        <label
          htmlFor="automation-reasoning-effort"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Reasoning Effort
        </label>
        <Select
          value={reasoningConfig ? value.reasoningEffort || DEFAULT_REASONING_VALUE : ""}
          onValueChange={(reasoningEffort) =>
            onChange({
              ...value,
              reasoningEffort: reasoningEffort === DEFAULT_REASONING_VALUE ? "" : reasoningEffort,
            })
          }
          disabled={!reasoningConfig}
        >
          <SelectTrigger id="automation-reasoning-effort" className="w-full">
            <SelectValue
              placeholder={reasoningConfig ? "Use model default" : "Not supported for this model"}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_REASONING_VALUE}>Use model default</SelectItem>
            {(reasoningConfig?.efforts ?? []).map((effort) => (
              <SelectItem key={effort} value={effort}>
                {effort}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          For models that support it, overrides how much chain-of-thought style reasoning is
          allowed. &quot;Use model default&quot; leaves the choice to the model.
        </FieldDescription>
      </div>
    </>
  );
}
