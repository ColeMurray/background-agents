"use client";

import { useId, useState } from "react";
import { ChevronDownIcon } from "@/components/ui/icons";

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <div className="border-t border-border-muted">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls={contentId}
        className="flex items-center justify-between w-full py-3 text-xs font-semibold text-foreground hover:text-accent transition-colors"
      >
        <span>{title}</span>
        <ChevronDownIcon
          className={`w-4 h-4 text-secondary-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>
      {isOpen && (
        <div id={contentId} className="pb-3">
          {children}
        </div>
      )}
    </div>
  );
}
