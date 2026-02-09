/**
 * Rivet Actor Registry.
 *
 * Configures all Rivet actors for the control plane.
 * This replaces the Cloudflare Durable Object bindings.
 */

import { setup } from "rivetkit";
import { sessionActor } from "./session";

/**
 * Registry of all actors managed by this control plane.
 *
 * The registry is used by the Hono server to mount the actor handler
 * and by the router to get actor references.
 */
export const registry = setup({
  actors: {
    session: sessionActor,
  },
});

/**
 * Type alias for the actor client.
 * Used to interact with actors from the router.
 */
export type ActorRegistry = typeof registry;
