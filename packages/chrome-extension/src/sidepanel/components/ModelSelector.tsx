import { useState, useRef, useEffect } from "react";
import {
  MODEL_OPTIONS,
  MODEL_REASONING_CONFIG,
  DEFAULT_MODEL,
  type ValidModel,
  type ReasoningEffort,
} from "@open-inspect/shared";
import { Button } from "@/components/ui/button";

interface ModelSelectorProps {
  model: ValidModel;
  reasoningEffort: ReasoningEffort | undefined;
  onModelChange: (model: ValidModel) => void;
  onReasoningChange: (effort: ReasoningEffort | undefined) => void;
}

export function ModelSelector({
  model,
  reasoningEffort,
  onModelChange,
  onReasoningChange,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const currentModel = MODEL_OPTIONS.flatMap((c) => c.models).find((m) => m.id === model);
  const reasoningConfig = MODEL_REASONING_CONFIG[model];

  return (
    <div className="space-y-2">
      {/* model dropdown */}
      <div ref={ref} className="relative">
        <Button
          variant="rebolt-outline"
          size="xs"
          onClick={() => setIsOpen(!isOpen)}
          className="w-full justify-between"
        >
          <span>{currentModel?.name || model}</span>
          <ChevronDownIcon />
        </Button>

        {isOpen && (
          <div className="absolute z-50 top-full mt-1 left-0 right-0 bg-white border border-ash-200 rounded-lg shadow-lg overflow-hidden">
            {MODEL_OPTIONS.map((category) => (
              <div key={category.category}>
                <div className="px-3 py-1.5 text-xs font-medium text-ash-500 bg-ash-100">
                  {category.category}
                </div>
                {category.models.map((m) => (
                  <Button
                    key={m.id}
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      onModelChange(m.id);
                      // reset reasoning effort when switching models
                      const newConfig = MODEL_REASONING_CONFIG[m.id];
                      onReasoningChange(newConfig?.default);
                      setIsOpen(false);
                    }}
                    className={`w-full text-left rounded-none h-auto py-2 px-3 flex-col items-start ${
                      m.id === model ? "bg-rebolt-100 text-rebolt-700" : ""
                    }`}
                  >
                    <div className="font-medium">{m.name}</div>
                    <div className="text-xs text-ash-500">{m.description}</div>
                  </Button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* reasoning effort pills */}
      {reasoningConfig && (
        <div className="flex items-center gap-1">
          {reasoningConfig.efforts.map((effort) => (
            <Button
              key={effort}
              variant={reasoningEffort === effort ? "rebolt-primary" : "ghost"}
              size="xs"
              onClick={() => onReasoningChange(effort)}
            >
              {effort}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// default model state helper
export function useModelState() {
  const [model, setModel] = useState<ValidModel>(DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | undefined>(
    MODEL_REASONING_CONFIG[DEFAULT_MODEL]?.default
  );

  return { model, reasoningEffort, setModel, setReasoningEffort };
}

function ChevronDownIcon() {
  return (
    <svg
      className="w-4 h-4 text-ash-400"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
