import { CheckIcon } from "@/components/ui/icons";

interface GlobalRepositoryOptionProps {
  selected: boolean;
  showDivider: boolean;
  onSelect: () => void;
}

export function GlobalRepositoryOption({
  selected,
  showDivider,
  onSelect,
}: GlobalRepositoryOptionProps) {
  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted transition ${
          selected ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        <div className="flex flex-col items-start text-left">
          <span className="font-medium">All Repositories (Global)</span>
          <span className="text-xs text-secondary-foreground">Shared across all repositories</span>
        </div>
        {selected && <CheckIcon className="w-4 h-4 text-accent" />}
      </button>
      {showDivider && <div className="border-t border-border my-1" />}
    </>
  );
}
