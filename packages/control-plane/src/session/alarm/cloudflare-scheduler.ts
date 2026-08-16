import type { AlarmScheduler } from "../../sandbox/lifecycle/manager";
import { createEarliestAlarmScheduler } from "./scheduler";

type DurableObjectAlarmStorage = Pick<DurableObjectStorage, "getAlarm" | "setAlarm">;

/** Adapt Cloudflare's one-alarm Durable Object storage to the neutral deadline scheduler. */
export function createCloudflareAlarmScheduler(storage: DurableObjectAlarmStorage): AlarmScheduler {
  return createEarliestAlarmScheduler(storage);
}
