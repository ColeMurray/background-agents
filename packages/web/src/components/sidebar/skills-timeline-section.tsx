"use client";

import type { SkillPhase } from "@/lib/skills";
import { ClockIcon, CheckCircleIcon } from "@/components/ui/icons";

interface SkillsTimelineSectionProps {
  phases: SkillPhase[];
}

export function SkillsTimelineSection({ phases }: SkillsTimelineSectionProps) {
  if (phases.length === 0) return null;

  return (
    <div className="space-y-1">
      {phases.map((phase, index) => (
        <SkillPhaseItem
          key={`${phase.name}-${phase.startedAt}`}
          phase={phase}
          isLast={index === phases.length - 1}
        />
      ))}
    </div>
  );
}

function SkillPhaseItem({ phase, isLast }: { phase: SkillPhase; isLast: boolean }) {
  const isActive = phase.status === "active";

  return (
    <div className="flex items-start gap-2">
      {/* Vertical line + status icon */}
      <div className="flex flex-col items-center flex-shrink-0">
        {isActive ? (
          <span className="mt-0.5">
            <ClockIcon className="w-4 h-4 text-accent animate-pulse" />
          </span>
        ) : (
          <span className="mt-0.5">
            <CheckCircleIcon className="w-4 h-4 text-success" />
          </span>
        )}
        {!isLast && <div className="w-px h-4 bg-border-muted mt-1" />}
      </div>

      {/* Content */}
      <div className="min-w-0 pb-1">
        <div className="flex items-center gap-2">
          <span
            className={`text-sm font-medium ${
              isActive ? "text-foreground" : "text-secondary-foreground"
            }`}
          >
            {phase.name}
          </span>
          {isActive && (
            <span className="text-[10px] font-semibold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
              ACTIVE
            </span>
          )}
        </div>
        {phase.description && (
          <p className="text-xs text-muted-foreground truncate">{phase.description}</p>
        )}
      </div>
    </div>
  );
}
