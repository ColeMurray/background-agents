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
    <div>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls={contentId}
        className="flex min-h-6 w-full items-center justify-between text-xs font-semibold text-foreground transition-colors hover:text-accent"
      >
        <span>{title}</span>
        <ChevronDownIcon
          className={`w-4 h-4 text-secondary-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>
      {isOpen && (
        <div id={contentId} className="pt-3">
          {children}
        </div>
      )}
    </div>
  );
}
