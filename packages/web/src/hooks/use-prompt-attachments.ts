"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_PROMPT_ATTACHMENTS,
  PROMPT_IMAGE_MIME_TYPES,
  type PromptAttachment,
} from "@open-inspect/shared";
import { WEB_PROMPT_IMAGE_MAX_BYTES } from "@/lib/prompt-attachment-limits";

export type PendingAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(PROMPT_IMAGE_MIME_TYPES);

export const ATTACHMENT_ACCEPT = [...IMAGE_MIME_TYPES].join(",");
export const DEFAULT_ATTACHMENT_ONLY_MESSAGE = "See the attached files.";

function isSupportedImage(file: File): boolean {
  return IMAGE_MIME_TYPES.has(file.type);
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
  const uploadedByIdRef = useRef(
    new Map<string, { sessionId: string; attachment: PromptAttachment }>()
  );
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

    for (const file of files) {
      if (!isSupportedImage(file)) {
        errors.push(`${file.name || "File"} is not a supported image`);
        continue;
      }
      if (attachmentCount >= MAX_PROMPT_ATTACHMENTS) {
        errors.push(`You can attach up to ${MAX_PROMPT_ATTACHMENTS} files per message`);
        break;
      }
      if (file.size > WEB_PROMPT_IMAGE_MAX_BYTES) {
        errors.push(
          `${file.name || "File"} is too large (images must be under ${formatMegabytes(WEB_PROMPT_IMAGE_MAX_BYTES)})`
        );
        continue;
      }

      additions.push({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      });
      attachmentCount += 1;
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
  const uploadAll = useCallback(async (sessionId: string): Promise<PromptAttachment[]> => {
    const pending = attachmentsRef.current;
    if (pending.length === 0) return [];

    setIsUploading(true);
    setAttachmentError(null);
    try {
      const uploaded: PromptAttachment[] = [];
      for (const pendingAttachment of pending) {
        const cached = uploadedByIdRef.current.get(pendingAttachment.id);
        if (cached?.sessionId === sessionId) {
          uploaded.push(cached.attachment);
          continue;
        }

        const formData = new FormData();
        formData.append("file", pendingAttachment.file, pendingAttachment.file.name || "image");
        const response = await fetch(`/api/sessions/${sessionId}/uploads`, {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error || `Failed to upload ${pendingAttachment.file.name}`);
        }
        const { uploadId } = (await response.json()) as {
          uploadId: string;
        };
        const attachment: PromptAttachment = {
          name: pendingAttachment.file.name || "image-attachment",
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
