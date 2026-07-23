/**
 * Key selection for CP→bot callback body signatures.
 *
 * Callbacks are signed with the DESTINATION bot's per-service secret — the
 * CP legitimately holds every bot's verification key, and the bot verifies
 * with its own.
 */

import { serviceAuthSecret, type ServiceKeyEnv } from "./authenticate";

/** The bots the CP delivers callbacks to — also the only services that may attach a `callbackContext`. */
export const CALLBACK_DESTINATIONS = ["slack-bot", "linear-bot"] as const;
export type CallbackDestination = (typeof CALLBACK_DESTINATIONS)[number];

export type CallbackSigningEnv = ServiceKeyEnv;

export function callbackSigningSecret(
  env: CallbackSigningEnv,
  destination: CallbackDestination
): string | undefined {
  return serviceAuthSecret(env, destination);
}
