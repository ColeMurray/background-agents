import type { RefObject } from "react";
import { SparkleIcon } from "@/components/ui/icons";
import type {
  ActiveSkillCompletion,
  PromptSkillSuggestion,
  PromptSkillSuggestionSource,
} from "@/lib/prompt-skill-completion";

type PromptSkillSuggestionPanelProps = {
  id: string;
  optionId: (skillId: string) => string;
  direction: "up" | "down";
  completion: ActiveSkillCompletion;
  source: PromptSkillSuggestionSource;
  matchingSkills: PromptSkillSuggestion[];
  activeSkillId?: string;
  listRef: RefObject<HTMLDivElement | null>;
  onActivate: (skillId: string) => void;
  onSelect: (skill: PromptSkillSuggestion) => void;
};

export function PromptSkillSuggestionPanel({
  id,
  optionId,
  direction,
  completion,
  source,
  matchingSkills,
  activeSkillId,
  listRef,
  onActivate,
  onSelect,
}: PromptSkillSuggestionPanelProps) {
  const position = direction === "up" ? "bottom-full mb-3" : "top-full mt-3";
  return (
    <div
      id={id}
      role="listbox"
      aria-label="Managed skills"
      aria-busy={source.status === "loading"}
      data-testid="prompt-skill-suggestions"
      className={`absolute ${position} left-0 right-0 z-50 overflow-hidden rounded-xl border border-border bg-background p-2 shadow-2xl`}
    >
      <div className="flex items-center justify-between gap-4 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Skills
        </span>
        <span className="text-xs text-muted-foreground">
          {source.status === "loading"
            ? "Loading..."
            : source.status === "error"
              ? "Unavailable"
              : matchingSkills.length > 0
                ? `${matchingSkills.length} available`
                : ""}
        </span>
      </div>
      <div ref={listRef} className="max-h-[min(22rem,50vh)] overflow-y-auto">
        {source.status === "loading" ? (
          <div className="flex items-center gap-3 rounded-lg px-3 py-4 text-sm text-muted-foreground">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            Loading managed skills...
          </div>
        ) : source.status === "error" ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            Managed skills could not be loaded. Try again shortly.
          </div>
        ) : matchingSkills.length > 0 ? (
          matchingSkills.map((skill) => (
            <button
              key={skill.skillId}
              id={optionId(skill.skillId)}
              type="button"
              role="option"
              aria-selected={skill.skillId === activeSkillId}
              data-skill-id={skill.skillId}
              onPointerMove={() => onActivate(skill.skillId)}
              onPointerDown={(event) => {
                event.preventDefault();
                onSelect(skill);
              }}
              className={`grid w-full grid-cols-[minmax(0,0.65fr)_minmax(0,1fr)] items-center gap-4 rounded-lg px-3 py-2.5 text-left transition sm:grid-cols-[minmax(0,0.55fr)_minmax(0,1fr)_auto] ${
                skill.skillId === activeSkillId ? "bg-accent-muted" : "hover:bg-muted"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2.5 font-mono text-sm font-medium text-foreground">
                <SparkleIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {completion.trigger}
                  {skill.name}
                </span>
              </span>
              <span className="truncate text-xs text-muted-foreground sm:text-sm">
                {skill.description}
              </span>
              <span className="hidden text-xs text-muted-foreground sm:block">Managed</span>
            </button>
          ))
        ) : (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            No managed skills match
            {completion.query ? ` "${completion.query}"` : " this session"}.
          </div>
        )}
      </div>
    </div>
  );
}
