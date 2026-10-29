import { createSessionMemoryAccessPolicy } from "../authorization/memory-access-factory";
import { MemoryPreferenceStore } from "../db/memory-preferences";
import { MemoryRecordStore } from "../db/memory-records";
import type { RequestContext } from "../http/request-context";
import { SessionMemorySelector } from "./session-memory-selector";

/** Wire the selector to D1-backed stores and access checks for one request. */
export function createSessionMemorySelector(ctx: RequestContext): SessionMemorySelector {
  return new SessionMemorySelector({
    preferences: new MemoryPreferenceStore(ctx.db),
    records: new MemoryRecordStore(ctx.db),
    access: createSessionMemoryAccessPolicy(ctx),
  });
}
