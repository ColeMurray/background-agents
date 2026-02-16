"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

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

  return (
    <div className="border-b border-ash-200 last:border-b-0">
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full justify-between px-4 py-3 text-ash-900"
      >
        <span>{title}</span>
        <svg
          className={`w-4 h-4 text-ash-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </Button>
      {isOpen && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}
