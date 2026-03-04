"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

interface FileUploadZoneProps {
  onFiles: (files: FileList | File[]) => void;
  children: ReactNode;
  disabled?: boolean;
}

export function FileUploadZone({ onFiles, children, disabled }: FileUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      dragCounter.current++;
      if (e.dataTransfer.items?.length) {
        setIsDragging(true);
      }
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounter.current = 0;
      if (disabled) return;

      if (e.dataTransfer.files?.length) {
        onFiles(e.dataTransfer.files);
      }
    },
    [onFiles, disabled]
  );

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className="relative"
    >
      {children}
      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-accent/50 border-2 border-dashed border-accent rounded pointer-events-none">
          <span className="text-sm font-medium text-foreground">Drop files here</span>
        </div>
      )}
    </div>
  );
}
