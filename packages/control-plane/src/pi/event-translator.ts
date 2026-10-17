import type { AgentEvent } from "@earendil-works/pi-durable";
import type { SandboxIngressEvent } from "@open-inspect/shared/types/sandbox-events";

export interface PiEventTranslationState {
  text: string;
}

export function translatePiEvents(
  events: readonly AgentEvent[],
  state: PiEventTranslationState,
  envelope: { sessionId: string; operationId: string; timestamp: number }
): SandboxIngressEvent[] {
  const translated: SandboxIngressEvent[] = [];
  let textChanged = false;
  for (const event of events) {
    switch (event.type) {
      case "turn_start":
        translated.push({
          type: "step_start",
          sandboxId: `pi:${envelope.sessionId}`,
          timestamp: envelope.timestamp,
          messageId: envelope.operationId,
          stepId: envelope.operationId,
        });
        break;
      case "message_update":
        for (const change of event.changes) {
          if (change.type !== "text_delta") continue;
          state.text += change.delta;
          textChanged = true;
        }
        break;
      case "compaction_end":
        if (!event.error) {
          translated.push({
            type: "context_compacted",
            sandboxId: `pi:${envelope.sessionId}`,
            timestamp: envelope.timestamp,
            messageId: envelope.operationId,
          });
        }
        break;
    }
  }
  if (textChanged) {
    translated.push({
      type: "token",
      sandboxId: `pi:${envelope.sessionId}`,
      timestamp: envelope.timestamp,
      messageId: envelope.operationId,
      content: state.text,
      partId: envelope.operationId,
    });
  }
  return translated;
}
