"use client";

import { useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent } from "react";

export function useAttachmentDropZone({
  locked,
  onAdd,
}: {
  locked: boolean;
  onAdd: (files: Iterable<File>) => void;
}) {
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (!locked && e.target.files?.length) {
      onAdd(e.target.files);
    }
    // Allow re-selecting the same file after removing it.
    e.target.value = "";
  };

  const handlePaste = (e: ClipboardEvent) => {
    if (locked) return;
    const files = e.clipboardData?.files;
    if (files?.length) {
      e.preventDefault();
      onAdd(files);
    }
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (locked) return;
    if (e.dataTransfer?.files?.length) {
      onAdd(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDraggingOver(false);
    }
  };

  return {
    isDraggingOver,
    handleFileInputChange,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragLeave,
  };
}
