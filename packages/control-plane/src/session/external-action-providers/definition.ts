import type { z } from "zod";
import type { JsonValue } from "@earendil-works/chord";

/**
 * The credential-free contract for one external publication.
 *
 * A definition names a provider, an action, the request it accepts, and how
 * to turn a provider response into a public result. It never names a
 * credential: the executor closes over one and keeps it there.
 */
export interface ExternalActionProviderDefinition {
  readonly provider: string;
  readonly action: string;
  /** The credential-free request the model may ask for. */
  readonly requestSchema: z.ZodType<{
    target: Record<string, JsonValue>;
    arguments: Record<string, JsonValue>;
  }>;
  /** The public, credential-free result an approver sees. */
  readonly publicResultSchema: z.ZodType<JsonValue>;
  /** Where the effect lands, from the credential-free target. */
  readonly endpoint: (target: Record<string, JsonValue>) => ProviderEndpoint;
  /** How the provider's own response is read. */
  readonly readResult: (body: unknown) => JsonValue;
  /** How the provider lists what was published, so a lost response can be reconciled. */
  readonly listPublished: (target: Record<string, JsonValue>) => ProviderEndpoint;
  /** The body the provider stores, so the effect can be found again later. */
  readonly composeBody: (
    target: Record<string, JsonValue>,
    args: Record<string, JsonValue>,
    marker: string
  ) => string;
  /** What the provider already published for this target. */
  readonly readPublished: (body: unknown) => unknown[];
  /** The marker an earlier publication left behind, if the provider echoes it. */
  readonly readMarker: (body: unknown) => string | null;
}

/** One provider endpoint, expressed without a credential. */
export interface ProviderEndpoint {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly body?: string;
  readonly accept?: string;
}

/** The marker that lets a lost response be reconciled instead of republished. */
export const EXTERNAL_ACTION_MARKER_PREFIX = "<!-- open-inspect-action:";

export function externalActionMarker(actionId: string): string {
  return `${EXTERNAL_ACTION_MARKER_PREFIX}${actionId} -->`;
}

/** Extract the action id a publication carries, if it carries one at all. */
export function readExternalActionMarker(text: string | null | undefined): string | null {
  if (!text) return null;
  const start = text.indexOf(EXTERNAL_ACTION_MARKER_PREFIX);
  if (start < 0) return null;
  const end = text.indexOf("-->", start);
  if (end < 0) return null;
  const id = text.slice(start + EXTERNAL_ACTION_MARKER_PREFIX.length, end).trim();
  return id.length > 0 ? id : null;
}
