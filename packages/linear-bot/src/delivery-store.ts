import type { Env } from "./types";

export type DeliveryClaim = "claimed" | "processing" | "processed" | "failed";

const DELIVERY_LEASE_MS = 15 * 60 * 1000;
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function claimDelivery(
  env: Env,
  deliveryId: string,
  leaseOwner: string
): Promise<DeliveryClaim> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO linear_webhook_deliveries
       (delivery_id, status, lease_owner, lease_expires_at, updated_at)
     VALUES (?, 'processing', ?, ?, ?)
     ON CONFLICT(delivery_id) DO UPDATE SET
       status = 'processing', lease_owner = excluded.lease_owner,
       lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at
     WHERE linear_webhook_deliveries.status = 'processing'
       AND (linear_webhook_deliveries.lease_owner = excluded.lease_owner
         OR linear_webhook_deliveries.lease_expires_at <= ?)`
  )
    .bind(deliveryId, leaseOwner, now + DELIVERY_LEASE_MS, now, now)
    .run();
  if ((result.meta.changes ?? 0) > 0) return "claimed";

  const existing = await env.DB.prepare(
    "SELECT status FROM linear_webhook_deliveries WHERE delivery_id = ?"
  )
    .bind(deliveryId)
    .first<{ status: "processing" | "processed" | "failed" }>();
  return existing?.status ?? "processing";
}

export async function deleteExpiredDeliveries(env: Env): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM linear_webhook_deliveries WHERE updated_at < ? AND status != 'processing'"
  )
    .bind(Date.now() - DELIVERY_RETENTION_MS)
    .run();
}

export async function markDeliveryProcessed(
  env: Env,
  deliveryId: string,
  leaseOwner: string
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE linear_webhook_deliveries
     SET status = 'processed', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE delivery_id = ? AND status = 'processing' AND lease_owner = ?`
  )
    .bind(Date.now(), deliveryId, leaseOwner)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new Error("Linear webhook delivery lease was lost");
}

export async function clearDeliveryClaim(
  env: Env,
  deliveryId: string,
  leaseOwner: string
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM linear_webhook_deliveries
     WHERE delivery_id = ? AND status = 'processing' AND lease_owner = ?`
  )
    .bind(deliveryId, leaseOwner)
    .run();
}

export async function markDeliveryFailed(
  env: Env,
  deliveryId: string,
  leaseOwner: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE linear_webhook_deliveries
     SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE delivery_id = ? AND status = 'processing' AND lease_owner = ?`
  )
    .bind(Date.now(), deliveryId, leaseOwner)
    .run();
}
