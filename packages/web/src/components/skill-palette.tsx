"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { BoltIcon } from "@/components/ui/icons";
import type { SkillInfo } from "@open-inspect/shared";

interface SkillPaletteProps {
  skills: SkillInfo[];
  isOpen: boolean;
  filterQuery: string;
  onSelect: (skillName: string) => void;
  onClose: () => void;
}

/**
 * Simple fuzzy match: check if all characters of the query appear
 * in order within the target string (case-insensitive).
 */
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  // Prefer prefix matches
  if (t.startsWith(q)) return 2;
  if (t.includes(q)) return 1;
  return 0;
}

export function SkillPalette({
  skills,
  isOpen,
  filterQuery,
  onSelect,
  onClose,
}: SkillPaletteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter and sort skills
  const filtered = skills
    .filter((s) => !filterQuery || fuzzyMatch(filterQuery, s.name))
    .sort((a, b) => {
      if (filterQuery) {
        return fuzzyScore(filterQuery, b.name) - fuzzyScore(filterQuery, a.name);
      }
      // Default: container first, then repo, alphabetical within
      if (a.source !== b.source) return a.source === "container" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  // Group by source
  const containerSkills = filtered.filter((s) => s.source === "container");
  const repoSkills = filtered.filter((s) => s.source === "repo");
  const orderedSkills = [...containerSkills, ...repoSkills];

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filterQuery]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, orderedSkills.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (orderedSkills[selectedIndex]) {
            onSelect(orderedSkills[selectedIndex].name);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [isOpen, orderedSkills, selectedIndex, onSelect, onClose]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!isOpen || orderedSkills.length === 0) return null;

  let flatIndex = 0;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto bg-card border border-border-muted rounded-lg shadow-lg z-50"
    >
      {containerSkills.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Container
          </div>
          {containerSkills.map((skill) => {
            const idx = flatIndex++;
            return (
              <SkillOption
                key={skill.name}
                skill={skill}
                isSelected={idx === selectedIndex}
                onClick={() => onSelect(skill.name)}
              />
            );
          })}
        </>
      )}
      {repoSkills.length > 0 && (
        <>
          {containerSkills.length > 0 && <div className="border-t border-border-muted" />}
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Repo
          </div>
          {repoSkills.map((skill) => {
            const idx = flatIndex++;
            return (
              <SkillOption
                key={skill.name}
                skill={skill}
                isSelected={idx === selectedIndex}
                onClick={() => onSelect(skill.name)}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

function SkillOption({
  skill,
  isSelected,
  onClick,
}: {
  skill: SkillInfo;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
        isSelected ? "bg-accent/10" : "hover:bg-accent/5"
      }`}
    >
      <BoltIcon
        className={`w-3.5 h-3.5 flex-shrink-0 ${
          skill.source === "container" ? "text-accent" : "text-purple-400"
        }`}
      />
      <div className="min-w-0">
        <div className="text-sm text-foreground font-medium">/{skill.name}</div>
        <div className="text-xs text-muted-foreground truncate">{skill.description}</div>
      </div>
      {isSelected && <span className="ml-auto text-xs text-muted-foreground flex-shrink-0">↵</span>}
    </button>
  );
}
