import { MODEL_REASONING_CONFIG, type ValidModel } from "@open-inspect/shared";

interface ReasoningEffortPillsProps {
  selectedModel: string;
  reasoningEffort: string | undefined;
  onSelect: (effort: string) => void;
  disabled: boolean;
}

export function ReasoningEffortPills({
  selectedModel,
  reasoningEffort,
  onSelect,
  disabled,
}: ReasoningEffortPillsProps) {
  const config = MODEL_REASONING_CONFIG[selectedModel as ValidModel];
  if (!config) return null;

  return (
    <div className="flex items-center gap-1">
      {config.efforts.map((effort) => (
        <button
          key={effort}
          type="button"
          onClick={() => onSelect(effort)}
          disabled={disabled}
          className={`px-2 py-0.5 text-xs transition ${
            reasoningEffort === effort
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-muted"
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {effort}
        </button>
      ))}
    </div>
  );
}
