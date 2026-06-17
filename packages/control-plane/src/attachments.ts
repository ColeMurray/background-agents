import {
  isPromptAttachmentMimeType,
  PROMPT_ATTACHMENT_MAX_BYTES,
  type Attachment,
  type PROMPT_ATTACHMENT_MIME_TYPES,
} from "@open-inspect/shared";

export {
  PROMPT_ATTACHMENT_MAX_BYTES,
  PROMPT_ATTACHMENT_LIMIT_PER_MESSAGE,
} from "@open-inspect/shared";

export const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const ATTACHMENT_FILENAME_MAX_LENGTH = 160;

const EXTENSION_MIME_TYPES: Record<string, (typeof PROMPT_ATTACHMENT_MIME_TYPES)[number]> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function sanitizeAttachmentFilename(name: string): string | null {
  const basename = name.split(/[\\/]/).pop()?.trim() ?? "";
  const withoutControlChars = Array.from(basename)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");
  const sanitized = withoutControlChars.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\s+/g, " ");
  const trimmed = sanitized
    .replace(/^[. ]+/, "")
    .slice(0, ATTACHMENT_FILENAME_MAX_LENGTH)
    .trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function inferAttachmentMimeType(
  filename: string,
  declaredMimeType?: string
): string | null {
  const normalizedDeclared = declaredMimeType?.split(";")[0]?.trim().toLowerCase();
  if (normalizedDeclared && isPromptAttachmentMimeType(normalizedDeclared)) {
    return normalizedDeclared;
  }

  const extension = filename.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (extension && EXTENSION_MIME_TYPES[extension]) {
    return EXTENSION_MIME_TYPES[extension];
  }

  return null;
}

export function buildAttachmentObjectKey(
  sessionId: string,
  attachmentId: string,
  filename: string
): string {
  return `sessions/${sessionId}/attachments/${attachmentId}/${filename}`;
}

export function buildAttachmentDownloadUrl(
  sessionId: string,
  attachmentId: string,
  filename: string
): string {
  return `/sessions/${sessionId}/attachments/${attachmentId}?filename=${encodeURIComponent(
    filename
  )}`;
}

export function attachmentTypeFromMimeType(mimeType: string): Attachment["type"] {
  return mimeType.startsWith("image/") ? "image" : "file";
}

export function validateAttachmentSize(sizeBytes: number): string | null {
  if (sizeBytes <= 0) return "Uploaded file is empty";
  if (sizeBytes > PROMPT_ATTACHMENT_MAX_BYTES) {
    return `Attachment uploads must be ${PROMPT_ATTACHMENT_MAX_BYTES} bytes or smaller`;
  }
  return null;
}
