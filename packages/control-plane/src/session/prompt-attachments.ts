import {
  promptImageMimeTypeSchema,
  type PromptAttachment,
  type ResolvedPromptAttachment,
} from "@open-inspect/shared";
import type { SessionAttachmentRepository } from "./session-attachment-repository";

export class PromptAttachmentError extends Error {}

export interface ResolvedPromptAttachments {
  attachments: ResolvedPromptAttachment[];
  attachmentIds: string[];
}

type PromptAttachmentRepository = Pick<SessionAttachmentRepository, "getUnreferenced">;

/** Resolve client references against canonical, unclaimed upload rows. */
export function resolvePromptAttachments(
  attachments: PromptAttachment[] | undefined,
  repository: PromptAttachmentRepository
): ResolvedPromptAttachments | undefined {
  if (!attachments || attachments.length === 0) return undefined;

  const attachmentIds = attachments.map((attachment) => attachment.uploadId);
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new PromptAttachmentError("An upload can only be attached once per message");
  }

  const uploads = new Map(
    repository.getUnreferenced(attachmentIds).map((upload) => [upload.id, upload] as const)
  );
  if (uploads.size !== attachmentIds.length) {
    throw new PromptAttachmentError("One or more uploads are missing, expired, or already used");
  }

  const resolved = attachments.map((attachment): ResolvedPromptAttachment => {
    const upload = uploads.get(attachment.uploadId);
    if (!upload) {
      throw new PromptAttachmentError("Upload not found");
    }
    const mimeType = promptImageMimeTypeSchema.safeParse(upload.mime_type);
    if (!mimeType.success) {
      throw new PromptAttachmentError("Upload is not a supported image");
    }
    return {
      name: attachment.name,
      uploadId: upload.id,
      mimeType: mimeType.data,
    };
  });

  return { attachments: resolved, attachmentIds };
}
