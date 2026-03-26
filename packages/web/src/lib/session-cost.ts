import type { SandboxEvent } from "@/types/session";

export function getTotalSessionCost(events: SandboxEvent[]): number {
  return events.reduce((total, event) => {
    if (event.type !== "step_finish") return total;
    if (typeof event.cost !== "number" || !Number.isFinite(event.cost)) return total;
    return total + event.cost;
  }, 0);
}

export function formatSessionCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toPrecision(2)}`;
}
