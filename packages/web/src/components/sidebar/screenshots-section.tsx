"use client";

import { useState } from "react";
import type { Artifact } from "@/types/session";
import { formatRelativeTime } from "@/lib/time";

interface ScreenshotsSectionProps {
  screenshots: Artifact[];
}

export function ScreenshotsSection({ screenshots }: ScreenshotsSectionProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (screenshots.length === 0) return null;

  return (
    <div className="space-y-3">
      {screenshots.map((screenshot) => (
        <div key={screenshot.id} className="space-y-1.5">
          {/* thumbnail */}
          {screenshot.url && (
            <button
              type="button"
              onClick={() =>
                setExpandedId(expandedId === screenshot.id ? null : screenshot.id)
              }
              className="w-full rounded-lg border border-ash-200 overflow-hidden hover:border-ash-300 transition-colors cursor-pointer"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={screenshot.url}
                alt={screenshot.metadata?.description || "Screenshot"}
                className="w-full h-auto"
                loading="lazy"
              />
            </button>
          )}

          {/* metadata */}
          <div className="flex items-center gap-2 text-xs text-ash-400">
            <CameraIcon className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">
              {screenshot.metadata?.description || "Screenshot"}
            </span>
            <span className="flex-shrink-0">{formatRelativeTime(screenshot.createdAt)}</span>
          </div>

          {/* expanded lightbox */}
          {expandedId === screenshot.id && screenshot.url && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
              onClick={() => setExpandedId(null)}
              role="dialog"
              aria-modal="true"
            >
              <div className="max-w-[90vw] max-h-[90vh] relative" onClick={(e) => e.stopPropagation()}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={screenshot.url}
                  alt={screenshot.metadata?.description || "Screenshot"}
                  className="max-w-full max-h-[90vh] rounded-lg shadow-2xl"
                />
                <button
                  type="button"
                  onClick={() => setExpandedId(null)}
                  className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition-colors"
                >
                  <CloseIcon className="w-4 h-4" />
                </button>
                {screenshot.metadata?.description && (
                  <p className="mt-2 text-sm text-white/80 text-center">
                    {screenshot.metadata.description}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CameraIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
      />
      <circle cx="12" cy="13" r="3" strokeWidth={2} />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
