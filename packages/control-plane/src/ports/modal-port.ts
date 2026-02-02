import type { CreateSandboxRequest, SandboxResponse, SnapshotResponse } from "./types";

export interface ModalPort {
  createSandbox(request: CreateSandboxRequest): Promise<SandboxResponse>;
  snapshotSandbox(sandboxId: string, sessionId: string, reason: string): Promise<SnapshotResponse>;
  // restoreSandbox(snapshotId: string): Promise<SandboxResponse>; // Not present in current usage, skipping for now or making optional?
}
