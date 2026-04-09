/**
 * Re-export shared HMAC-SHA256 primitive.
 *
 * The canonical implementation lives in @open-inspect/shared.
 * This module re-exports it for backward compatibility with existing imports.
 */

export { computeHmacHex } from "@open-inspect/shared";
