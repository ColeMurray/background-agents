"use client";

import { useState } from "react";

interface ScreenshotImageProps {
  base64: string;
  mimeType: string;
  filename?: string;
}

export function ScreenshotImage({ base64, mimeType, filename }: ScreenshotImageProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const src = `data:${mimeType};base64,${base64}`;

  return (
    <>
      <div className="mt-2">
        {filename && (
          <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <svg
              className="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            {filename}
          </div>
        )}
        <button
          onClick={() => setIsExpanded(true)}
          className="block border border-border-muted rounded overflow-hidden hover:border-accent transition-colors max-w-md"
        >
          <img src={src} alt={filename || "Screenshot"} className="w-full h-auto" loading="lazy" />
        </button>
      </div>

      {/* Lightbox overlay */}
      {isExpanded && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 cursor-pointer"
          onClick={() => setIsExpanded(false)}
        >
          <img
            src={src}
            alt={filename || "Screenshot"}
            className="max-w-full max-h-full object-contain rounded shadow-lg"
          />
        </div>
      )}
    </>
  );
}
