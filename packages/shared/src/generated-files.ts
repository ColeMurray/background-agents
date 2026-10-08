import { z } from "zod";

export const GENERATED_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const GENERATED_FILE_MAX_COUNT_PER_SESSION = 100;
export const GENERATED_FILE_MAX_BYTES_PER_SESSION = 500 * 1024 * 1024;
export const GENERATED_FILE_MULTIPART_MAX_BYTES = GENERATED_FILE_MAX_BYTES + 128 * 1024;
export const GENERATED_FILE_MAX_FILENAME_BYTES = 255;
export const GENERATED_FILE_MAX_CAPTION_CHARS = 1000;

const MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  pdf: "application/pdf",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Extension hints only: arbitrary formats remain opaque downloadable files. */
export function getGeneratedFileMimeType(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  const extension = dotIndex < 0 ? "" : filename.slice(dotIndex + 1).toLowerCase();
  return Object.hasOwn(MIME_TYPES_BY_EXTENSION, extension)
    ? MIME_TYPES_BY_EXTENSION[extension]
    : "application/octet-stream";
}

function hasForbiddenFilenameCharacters(filename: string): boolean {
  return Array.from(filename).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 || char === "/" || char === "\\";
  });
}

function isSafeFilename(filename: string): boolean {
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    hasForbiddenFilenameCharacters(filename)
  )
    return false;
  // URI encoding also rejects unpaired surrogates, which cannot round-trip in headers.
  try {
    encodeURIComponent(filename);
  } catch {
    return false;
  }
  return new TextEncoder().encode(filename).byteLength <= GENERATED_FILE_MAX_FILENAME_BYTES;
}

/** Persisted filenames must already be canonical; reads never repair corrupt metadata. */
export const generatedFileFilenameSchema = z
  .string()
  .refine((filename) => filename === filename.normalize("NFC").trim() && isSafeFilename(filename), {
    message: "Invalid generated file filename",
  });

/** Normalize user input once, before writing metadata or constructing headers. */
export function normalizeGeneratedFileFilename(filename: string): string {
  // Trimming must not silently turn control-bearing input into an accepted filename.
  if (hasForbiddenFilenameCharacters(filename)) throw new Error("Invalid generated file filename");
  return generatedFileFilenameSchema.parse(filename.normalize("NFC").trim());
}

export const generatedFileCaptionSchema = z.string().max(GENERATED_FILE_MAX_CAPTION_CHARS);
export const generatedFileSizeSchema = z.number().int().positive().max(GENERATED_FILE_MAX_BYTES);

export const generatedFileDetailsSchema = z
  .strictObject({
    filename: generatedFileFilenameSchema,
    mimeType: z.string(),
    sizeBytes: generatedFileSizeSchema,
  })
  .refine((file) => file.mimeType === getGeneratedFileMimeType(file.filename), {
    message: "MIME type must match the canonical filename hint",
    path: ["mimeType"],
  });

function asciiFilename(filename: string): string {
  return Array.from(filename, (char) => (char.charCodeAt(0) > 126 ? "_" : char)).join("");
}

/** Full attachment header with a quoted ASCII fallback and a Unicode filename*. */
export function formatGeneratedFileDisposition(filename: string): string {
  const canonical = generatedFileFilenameSchema.parse(filename);
  const fallback = asciiFilename(canonical).replace(/"/g, '\\"');
  const encoded = encodeURIComponent(canonical).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Parse our protected download header, rejecting malformed or inconsistent filenames. */
export function parseGeneratedFileDisposition(value: string): string | null {
  const match = /^attachment; filename="((?:[^"\\]|\\")*)"; filename\*=UTF-8''([^;]+)$/i.exec(
    value
  );
  if (!match) return null;
  try {
    const filename = generatedFileFilenameSchema.parse(decodeURIComponent(match[2]));
    return match[1].replace(/\\"/g, '"') === asciiFilename(filename) ? filename : null;
  } catch {
    return null;
  }
}
