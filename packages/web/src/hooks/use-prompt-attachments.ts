"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "@open-inspect/shared";

export type PendingAttachment = {
  id: string;
  file: File;
  previewUrl: string;
  kind: "image" | "video";
};

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

// Mirrors the control plane's prompt upload caps (see packages/control-plane/src/media.ts).
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS = 6;
export const MAX_VIDEO_ATTACHMENTS = 2;

export const ATTACHMENT_ACCEPT = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES].join(",");
export const DEFAULT_ATTACHMENT_ONLY_MESSAGE = "See the attached files.";

function attachmentKind(file: File): "image" | "video" | null {
  if (IMAGE_MIME_TYPES.has(file.type)) return "image";
  if (VIDEO_MIME_TYPES.has(file.type)) return "video";
  return null;
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Pending chat-composer attachments. Files stay local (object URLs for
 * preview) until the prompt is submitted; uploadAll() then stores each file
 * via the session uploads API and returns the lightweight attachment
 * references to send with the prompt.
 */
export function usePromptAttachments() {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const uploadedByIdRef = useRef(new Map<string, { sessionId: string; attachment: Attachment }>());
  attachmentsRef.current = attachments;

  // Revoke preview URLs on unmount only — removals revoke their own URL.
  useEffect(() => {
    return () => {
      for (const attachment of attachmentsRef.current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  const addFiles = useCallback((files: Iterable<File>) => {
    setAttachmentError(null);
    const errors: string[] = [];
    const current = attachmentsRef.current;
    const additions: PendingAttachment[] = [];
    let attachmentCount = current.length;
    let videoCount = current.filter((attachment) => attachment.kind === "video").length;

    for (const file of files) {
      const kind = attachmentKind(file);
      if (!kind) {
        errors.push(`${file.name || "File"} is not a supported image or video`);
        continue;
      }
      if (attachmentCount >= MAX_ATTACHMENTS) {
        errors.push(`You can attach up to ${MAX_ATTACHMENTS} files per message`);
        break;
      }
      if (kind === "video" && videoCount >= MAX_VIDEO_ATTACHMENTS) {
        errors.push(`You can attach up to ${MAX_VIDEO_ATTACHMENTS} videos per message`);
        continue;
      }
      const maxBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
      if (file.size > maxBytes) {
        errors.push(
          `${file.name || "File"} is too large (${kind}s must be under ${formatMegabytes(maxBytes)})`
        );
        continue;
      }

      additions.push({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        kind,
      });
      attachmentCount += 1;
      if (kind === "video") videoCount += 1;
    }

    if (additions.length > 0) {
      setAttachments((prev) => [...prev, ...additions]);
    }

    if (errors.length > 0) {
      setAttachmentError(errors[0]);
    }
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachmentError(null);
    setAttachments((prev) => {
      const removed = prev.find((attachment) => attachment.id === id);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
        uploadedByIdRef.current.delete(removed.id);
      }
      return prev.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      for (const attachment of prev) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      uploadedByIdRef.current.clear();
      return [];
    });
  }, []);

  /**
   * Upload all pending attachments and return the references to send with the
   * prompt. Throws (with a user-readable message) if any upload fails; the
   * pending list is left intact so the user can retry.
   */
  const uploadAll = useCallback(async (sessionId: string): Promise<Attachment[]> => {
    const pending = attachmentsRef.current;
    if (pending.length === 0) return [];

    setIsUploading(true);
    setAttachmentError(null);
    try {
      const uploaded: Attachment[] = [];
      for (const pendingAttachment of pending) {
        const cached = uploadedByIdRef.current.get(pendingAttachment.id);
        if (cached?.sessionId === sessionId) {
          uploaded.push(cached.attachment);
          continue;
        }

        const formData = new FormData();
        formData.append(
          "file",
          pendingAttachment.file,
          pendingAttachment.file.name || pendingAttachment.kind
        );
        const response = await fetch(`/api/sessions/${sessionId}/uploads`, {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error || `Failed to upload ${pendingAttachment.file.name}`);
        }
        const { uploadId, mimeType } = (await response.json()) as {
          uploadId: string;
          mimeType: string;
        };
        const attachment: Attachment = {
          type: pendingAttachment.kind === "image" ? "image" : "file",
          name: pendingAttachment.file.name || `${pendingAttachment.kind}-attachment`,
          mimeType,
          uploadId,
        };
        uploadedByIdRef.current.set(pendingAttachment.id, { sessionId, attachment });
        uploaded.push(attachment);
      }
      return uploaded;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to upload attachments";
      setAttachmentError(message);
      throw error;
    } finally {
      setIsUploading(false);
    }
  }, []);

  return {
    attachments,
    attachmentError,
    isUploading,
    addFiles,
    removeAttachment,
    clearAttachments,
    uploadAll,
  };
}
