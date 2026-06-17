export const PROMPT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const PROMPT_ATTACHMENT_LIMIT_PER_MESSAGE = 10;

export const PROMPT_ATTACHMENT_ACCEPT = [
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".docx",
  ".xlsx",
  ".pptx",
].join(",");

export const PROMPT_ATTACHMENT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/csv",
  "application/json",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export type PromptAttachmentMimeType = (typeof PROMPT_ATTACHMENT_MIME_TYPES)[number];

const PROMPT_ATTACHMENT_MIME_TYPE_SET = new Set<string>(PROMPT_ATTACHMENT_MIME_TYPES);

export function isPromptAttachmentMimeType(value: string): value is PromptAttachmentMimeType {
  return PROMPT_ATTACHMENT_MIME_TYPE_SET.has(value);
}
