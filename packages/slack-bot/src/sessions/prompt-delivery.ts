/**
 * The one place a prompt with Slack image attachments is delivered to a
 * session: upload the prepared images, send the prompt with their references,
 * and notify the user about dropped images only once the prompt outcome is
 * known. Both the follow-up path and the new-session launcher go through this,
 * so the sequencing lives in exactly one place.
 */

import type { CallbackContext, SendPromptResponse } from "@open-inspect/shared";
import {
  notifyDroppedAttachments,
  uploadPreparedAttachments,
  type PreparedImageAttachments,
} from "../attachments";
import type { Env } from "../types";
import { sendPrompt } from "./control-plane-client";

export interface DeliverPromptOptions {
  sessionId: string;
  /** Full prompt body, already including any channel/thread context. */
  content: string;
  authorId: string;
  /** Downloaded images from {@link prepareImageAttachments}. */
  attachments: PreparedImageAttachments;
  /**
   * True when the user's message carried no text — the prompt is a generic
   * placeholder that is only meaningful if at least one image lands.
   */
  imageOnly: boolean;
  callbackContext?: CallbackContext;
  /** Thread where attachment-drop notices are posted. */
  channel: string;
  threadTs: string;
  traceId?: string;
}

export type DeliverPromptResult =
  | { ok: true; data: SendPromptResponse }
  /**
   * "stale": the session no longer exists (retry against a new session).
   * "transient": the prompt send failed; the user should be told to retry.
   * "no_images_delivered": an image-only request lost every image, so no
   * prompt was sent — the user has already been notified.
   */
  | { ok: false; reason: "stale" | "transient" | "no_images_delivered" };

/** Deliver one prompt and its image attachments to a session. */
export async function deliverPrompt(
  env: Env,
  options: DeliverPromptOptions
): Promise<DeliverPromptResult> {
  const {
    sessionId,
    content,
    authorId,
    attachments,
    imageOnly,
    callbackContext,
    channel,
    threadTs,
    traceId,
  } = options;
  const upload = await uploadPreparedAttachments(env, sessionId, attachments, traceId);

  if (imageOnly && upload.references.length === 0) {
    // The placeholder prompt would launch a meaningless run with nothing
    // attached. When the uploads failed only because the session is gone,
    // surface staleness instead so the caller retries on a fresh session.
    if (upload.sessionMissing) return { ok: false, reason: "stale" };
    await notifyDroppedAttachments(env, channel, threadTs, upload, {
      traceId,
      nothingSent: true,
    });
    return { ok: false, reason: "no_images_delivered" };
  }

  const promptResult = await sendPrompt(env, {
    sessionId,
    content,
    authorId,
    callbackContext,
    attachments: upload.references,
    traceId,
  });
  if (!promptResult.ok) return promptResult;
  // Notify about dropped images only now that the session proved live —
  // uploads against a stale session fail spuriously and are retried against
  // the replacement session.
  await notifyDroppedAttachments(env, channel, threadTs, upload, { traceId });
  return promptResult;
}
