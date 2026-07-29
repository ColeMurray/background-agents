"use client";

import {
  getReasoningConfig,
  isValidReasoningEffort,
  type ModelCategory,
} from "@open-inspect/shared";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SYSTEM_DEFAULT_VALUE = "__system_default__";
const MODEL_DEFAULT_VALUE = "__model_default__";

export function ModelReasoningDefaultsFields({
  model,
  reasoningEffort,
  modelOptions,
  onChange,
}: {
  model: string;
  reasoningEffort: string;
  modelOptions: ModelCategory[];
  onChange: (model: string, reasoningEffort: string) => void;
}) {
  const reasoningConfig = getReasoningConfig(model);

  return (
    <div className="grid sm:grid-cols-2 gap-3 mb-4">
      <label className="text-sm">
        <span className="block text-foreground font-medium mb-1">Default model</span>
        <Select
          value={model || SYSTEM_DEFAULT_VALUE}
          onValueChange={(nextModel) => {
            if (nextModel === SYSTEM_DEFAULT_VALUE) {
              onChange("", "");
              return;
            }
            onChange(
              nextModel,
              reasoningEffort && isValidReasoningEffort(nextModel, reasoningEffort)
                ? reasoningEffort
                : ""
            );
          }}
        >
          <SelectTrigger className="w-full" aria-label="Default model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SYSTEM_DEFAULT_VALUE}>Use system default</SelectItem>
            {modelOptions.map((group) => (
              <SelectGroup key={group.category}>
                <SelectLabel>{group.category}</SelectLabel>
                {group.models.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="text-sm">
        <span className="block text-foreground font-medium mb-1">Default reasoning effort</span>
        <Select
          value={reasoningEffort || MODEL_DEFAULT_VALUE}
          onValueChange={(value) => onChange(model, value === MODEL_DEFAULT_VALUE ? "" : value)}
          disabled={!reasoningConfig}
        >
          <SelectTrigger className="w-full" aria-label="Default reasoning effort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={MODEL_DEFAULT_VALUE}>Use model default</SelectItem>
            {(reasoningConfig?.efforts ?? []).map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    </div>
  );
}
