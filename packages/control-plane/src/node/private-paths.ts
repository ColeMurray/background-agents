/**
 * Files under the host's data directory hold session state, tokens and
 * sandbox credentials, so they are private to the host user. chmod runs
 * after creation so a pre-existing path or a permissive umask cannot widen
 * them.
 */

import { chmodSync, mkdirSync } from "node:fs";

const PRIVATE_DIRECTORY = 0o700;
const PRIVATE_FILE = 0o600;

/** Create `directory` if needed and make it private to the host user. */
export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY });
  chmodSync(directory, PRIVATE_DIRECTORY);
}

/** Make an existing file private to the host user. */
export function makeFilePrivate(path: string): void {
  chmodSync(path, PRIVATE_FILE);
}
