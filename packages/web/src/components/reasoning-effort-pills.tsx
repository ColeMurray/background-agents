import {
  MODEL_REASONING_CONFIG,
  type ValidModel,
  type ReasoningEffort,
} from "@open-inspect/shared";

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

  // If effort is not in the list (e.g. model just changed), -1 wraps to index 0 on cycle
  const currentIndex = reasoningEffort
    ? config.efforts.indexOf(reasoningEffort as ReasoningEffort)
    : -1;
  const handleCycle = () => {
    const nextIndex = (currentIndex + 1) % config.efforts.length;
    onSelect(config.efforts[nextIndex]);
  };

  return (
    <button
      type="button"
      onClick={handleCycle}
      disabled={disabled}
      className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground transition disabled:opacity-50 disabled:cursor-not-allowed"
      title={`Reasoning: ${reasoningEffort ?? config.default ?? "default"} (click to cycle)`}
    >
      {reasoningEffort ?? config.default ?? "default"}
    </button>
  );
}
