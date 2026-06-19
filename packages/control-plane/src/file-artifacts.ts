export const FILE_ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;
export const FILE_ARTIFACT_ID_PATTERN = /^[A-Za-z0-9-]+$/;

const FILENAME_MAX_LENGTH = 180;

const EXTENSION_MIME_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

const ALLOWED_DECLARED_MIME_TYPES = new Set<string>([
  ...Object.values(EXTENSION_MIME_TYPES),
  "application/csv",
  "application/x-zip-compressed",
]);

export function sanitizeFileArtifactFilename(name: string): string | null {
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
    .slice(0, FILENAME_MAX_LENGTH)
    .trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function inferFileArtifactMimeType(
  filename: string,
  declaredMimeType?: string
): string | null {
  const normalizedDeclared = declaredMimeType?.split(";")[0]?.trim().toLowerCase();
  if (normalizedDeclared && ALLOWED_DECLARED_MIME_TYPES.has(normalizedDeclared)) {
    return normalizedDeclared === "application/x-zip-compressed"
      ? "application/zip"
      : normalizedDeclared;
  }

  const extension = filename.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (extension && EXTENSION_MIME_TYPES[extension]) {
    return EXTENSION_MIME_TYPES[extension];
  }

  return null;
}

export function buildFileArtifactObjectKey(
  sessionId: string,
  artifactId: string,
  filename: string
): string {
  return `sessions/${sessionId}/files/${artifactId}/${filename}`;
}

export function validateFileArtifactSize(sizeBytes: number): string | null {
  if (sizeBytes <= 0) return "Uploaded file is empty";
  if (sizeBytes > FILE_ARTIFACT_MAX_BYTES) {
    return `File artifact uploads must be ${FILE_ARTIFACT_MAX_BYTES} bytes or smaller`;
  }
  return null;
}
