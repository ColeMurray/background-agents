import type { HarnessId } from "@open-inspect/shared/harnesses";
import type { FeatureCapabilityMode } from "@open-inspect/shared/capability-modes";
import type { ResolvedSessionAttachment } from "@open-inspect/shared/types/session-attachments";

export interface InProcessHarnessPrompt {
  sessionId: string;
  messageId: string;
  content: string;
  model: string;
  reasoningEffort?: string | null;
  requirePricing?: boolean;
  executionDeadlineMs?: number;
  attachments?: ResolvedSessionAttachment[];
}

export interface InProcessHarnessReceipt {
  operationId: string;
  accepted: boolean;
  rejected?: string;
}

/** Model-producing maintenance that remains owned by SessionMessageQueue. */
export type InProcessHarnessControl = {
  kind: "compact-context";
  conversationId?: string;
  instructions?: string;
};

export interface InProcessHarnessControlPrompt extends InProcessHarnessPrompt {
  control: InProcessHarnessControl;
}

export interface InProcessHarnessCapabilitySnapshot {
  version: number;
  capabilities: Readonly<Record<string, FeatureCapabilityMode>>;
}

export type InProcessHarnessOperationStatus =
  | { status: "not_found" }
  | { status: "queued" | "running" | "sleeping" | "parked" }
  | {
      status: "settled";
      result: { status: "done" | "unanswered"; reason?: string };
    };

/** Neutral port for a harness whose runtime is not owned by a sandbox. */
export interface InProcessHarnessRuntime {
  readonly harness: HarnessId;
  initialize(sessionId: string, snapshot: InProcessHarnessCapabilitySnapshot): Promise<void>;
  submit(input: InProcessHarnessPrompt): Promise<InProcessHarnessReceipt>;
  submitControl(input: InProcessHarnessControlPrompt): Promise<InProcessHarnessReceipt>;
  lookup(sessionId: string, operationId: string): Promise<InProcessHarnessOperationStatus>;
  abort(sessionId: string, operationId?: string): Promise<boolean>;
  preserveForArchive(sessionId: string): Promise<void>;
  restoreFromArchive(sessionId: string): Promise<void>;
  destroy(sessionId: string): Promise<void>;
}
