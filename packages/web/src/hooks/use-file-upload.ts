"use client";

import { useState, useCallback } from "react";

export interface PendingAttachment {
  id: string;
  file: File;
  name: string;
  type: "file" | "image";
  mimeType: string;
  previewUrl?: string;
  uploading: boolean;
  url?: string;
  error?: string;
}

export interface UploadedAttachment {
  type: string;
  name: string;
  url: string;
  mimeType: string;
}

const MAX_FILES = 5;
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "application/json",
];

async function uploadFile(file: File): Promise<string> {
  const response = await fetch("/api/media/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": file.name,
    },
    body: file,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }

  const data = await response.json();
  return data.url;
}

export function useFileUpload() {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const newFiles = Array.from(files).slice(0, MAX_FILES);

    setAttachments((prev) => {
      const remaining = MAX_FILES - prev.length;
      if (remaining <= 0) return prev;

      const toAdd = newFiles.slice(0, remaining);
      const pending: PendingAttachment[] = toAdd
        .filter((f) => f.size <= MAX_SIZE && ALLOWED_TYPES.includes(f.type))
        .map((file) => ({
          id: crypto.randomUUID(),
          file,
          name: file.name,
          type: file.type.startsWith("image/") ? "image" : "file",
          mimeType: file.type,
          previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
          uploading: true,
        }));

      // Start uploads
      for (const att of pending) {
        uploadFile(att.file)
          .then((url) => {
            setAttachments((curr) =>
              curr.map((a) => (a.id === att.id ? { ...a, uploading: false, url } : a))
            );
          })
          .catch((err) => {
            setAttachments((curr) =>
              curr.map((a) =>
                a.id === att.id ? { ...a, uploading: false, error: String(err) } : a
              )
            );
          });
      }

      return [...prev, ...pending];
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      for (const att of prev) {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      }
      return [];
    });
  }, []);

  const getUploadedAttachments = useCallback((): UploadedAttachment[] => {
    return attachments
      .filter((a): a is PendingAttachment & { url: string } => !!a.url && !a.error)
      .map((a) => ({
        type: a.type,
        name: a.name,
        url: a.url,
        mimeType: a.mimeType,
      }));
  }, [attachments]);

  const allUploaded = attachments.length > 0 && attachments.every((a) => !a.uploading);
  const hasAttachments = attachments.length > 0;

  return {
    attachments,
    addFiles,
    removeAttachment,
    clearAttachments,
    getUploadedAttachments,
    allUploaded,
    hasAttachments,
  };
}
