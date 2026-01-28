/**
 * Generate OpenCode-compatible ascending IDs.
 *
 * Port of OpenCode's TypeScript implementation:
 * https://github.com/anomalyco/opencode/blob/8f0d08fae07c97a090fcd31d0d4c4a6fa7eeaa1d/packages/opencode/src/id/id.ts
 *
 * Format: {prefix}_{timestamp_hex}{random_base62}
 * - prefix: type identifier (e.g., "msg" for messages)
 * - timestamp_hex: 12 hex chars encoding (timestamp_ms * 0x1000 + counter)
 * - random_base62: 14 random base62 characters
 *
 * IDs are monotonically increasing, ensuring new user messages always have
 * IDs greater than previous assistant messages (required for OpenCode's
 * prompt loop).
 */

import * as crypto from "node:crypto";

const PREFIXES: Record<string, string> = {
  session: "ses",
  message: "msg",
  part: "prt",
};

const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANDOM_LENGTH = 14;

// Class-level state for monotonic generation
let lastTimestamp = 0;
let counter = 0;

/**
 * Generate random base62 string.
 */
function randomBase62(length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = crypto.randomInt(62);
    result += BASE62_CHARS[randomIndex];
  }
  return result;
}

/**
 * Generate an ascending ID with the given prefix.
 *
 * @param prefix - One of: "session", "message", "part"
 * @returns OpenCode-compatible ascending ID
 */
export function ascending(prefix: string): string {
  const prefixStr = PREFIXES[prefix];
  if (!prefixStr) {
    throw new Error(`Unknown prefix: ${prefix}`);
  }

  const currentTimestamp = Date.now();

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp;
    counter = 0;
  }
  counter++;

  const encoded = currentTimestamp * 0x1000 + counter;
  // Keep only 48 bits (6 bytes) and convert directly to hex
  const encoded48bit = BigInt(encoded) & BigInt("0xFFFFFFFFFFFF");
  const hexValue = encoded48bit.toString(16).padStart(12, "0");

  const randomSuffix = randomBase62(RANDOM_LENGTH);

  return `${prefixStr}_${hexValue}${randomSuffix}`;
}

/**
 * Generate a message ID.
 */
export function messageId(): string {
  return ascending("message");
}

/**
 * Generate a session ID.
 */
export function sessionId(): string {
  return ascending("session");
}

/**
 * Generate a part ID.
 */
export function partId(): string {
  return ascending("part");
}
