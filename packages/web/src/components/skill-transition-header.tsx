import { BoltIcon } from "@/components/ui/icons";

interface SkillTransitionHeaderProps {
  skillName: string;
  description?: string;
}

export function SkillTransitionHeader({ skillName, description }: SkillTransitionHeaderProps) {
  return (
    <div className="flex items-center gap-2 py-2 border-b border-border-muted">
      <span className="inline-flex items-center gap-1 bg-accent/10 text-accent px-2 py-0.5 rounded-full text-xs font-semibold">
        <BoltIcon className="w-3 h-3" />
        {skillName}
      </span>
      {description && <span className="text-xs text-muted-foreground truncate">{description}</span>}
    </div>
  );
}
