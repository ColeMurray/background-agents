import { MemoryPreferenceStore } from "../db/memory-preferences";
import { MemoryRecordStore } from "../db/memory-records";
import type { SqlDatabase } from "../db/sql-database";
import { SessionMemoryResolver } from "./session-memory-resolver";

/** Wire the resolver to D1-backed stores. */
export function createSessionMemoryResolver(db: SqlDatabase): SessionMemoryResolver {
  return new SessionMemoryResolver({
    preferences: new MemoryPreferenceStore(db),
    records: new MemoryRecordStore(db),
  });
}
