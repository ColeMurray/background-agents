/** Portable limit for images sent through the web app's multipart proxy. */
export const WEB_PROMPT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Full multipart request budget, including boundaries and file metadata.
 * Kept below Vercel's 4.5 MB function request-body limit.
 */
export const WEB_PROMPT_UPLOAD_MAX_REQUEST_BYTES = 4_400_000;
