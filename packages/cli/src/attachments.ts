import { SESSION_ATTACHMENT_IMAGE_MAX_BYTES } from "@open-inspect/shared/types/session-attachments";
import { CliError } from "./errors.js";

export function validateAttachmentBytes(bytes: Uint8Array, name: string): void {
  if (bytes.byteLength === 0) throw new CliError("validation", `Attachment is empty: ${name}`);
  if (bytes.byteLength > SESSION_ATTACHMENT_IMAGE_MAX_BYTES) {
    throw new CliError("validation", `Attachment exceeds 10 MiB: ${name}`);
  }
  if (!isSupportedImage(bytes)) {
    throw new CliError("validation", `Attachment is not PNG, JPEG, WebP, or GIF: ${name}`);
  }
}

function isSupportedImage(bytes: Uint8Array): boolean {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const isPng = png.every((byte, index) => bytes[index] === byte);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const signature = new TextDecoder().decode(bytes.slice(0, 12));
  const isGif = signature.startsWith("GIF87a") || signature.startsWith("GIF89a");
  const isWebp = signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP";
  return isPng || isJpeg || isGif || isWebp;
}
