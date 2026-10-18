import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import type { SandboxIngressEvent } from "@open-inspect/shared/types/sandbox-events";

export interface PiEventTranslationState {
  text: string;
  tools?: Map<string, PiToolTranslationState>;
}

interface PiToolTranslationState {
  tool: string;
  args: Record<string, unknown>;
  output: string;
  isSubtask?: boolean;
  taskCallId?: string;
}

const REDACTED = "[redacted]";

export function translatePiEvents(
  events: readonly AgentEvent[],
  state: PiEventTranslationState,
  envelope: { sessionId: string; operationId: string; timestamp: number }
): SandboxIngressEvent[] {
  const translated: SandboxIngressEvent[] = [];
  let textChanged = false;
  const tools = (state.tools ??= new Map());
  for (const event of events) {
    switch (event.type) {
      case "snapshot": {
        if (!event.run && !event.generation) {
          translated.push(...settledSnapshotEvents(event, state, envelope));
        }
        const partial = event.generation?.message;
        const recoveredText = partial ? assistantText(partial) : state.text;
        if (partial && recoveredText !== state.text) {
          state.text = recoveredText;
          translated.push(tokenEvent(state.text, envelope));
        }
        const calls = toolCalls(partial ?? latestAssistant(event));
        for (const slot of event.tools) {
          const current = {
            tool: slot.name,
            args: calls.get(slot.callId) ?? {},
            output: slot.output ?? "",
          };
          tools.set(slot.callId, current);
          translated.push(
            toolEvent(
              current,
              slot.callId,
              slot.status === "done" ? snapshotToolStatus(event, slot.entry) : slot.status,
              envelope
            )
          );
        }
        for (const slot of event.nestedTools) {
          const current = {
            tool: slot.name,
            args: slot.arguments,
            output: slot.output ?? "",
            isSubtask: true,
            taskCallId: slot.parentCallId,
          };
          tools.set(slot.callId, current);
          translated.push(
            toolEvent(
              current,
              slot.callId,
              slot.status === "done"
                ? slot.summary?.isError
                  ? "failed"
                  : "completed"
                : slot.status,
              envelope
            )
          );
        }
        break;
      }
      case "turn_start":
        break;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "text_delta") {
            state.text += change.delta;
            textChanged = true;
          } else if (change.type === "message") {
            const text = assistantText(change.message);
            if (text !== state.text) {
              state.text = text;
              textChanged = true;
            }
          }
        }
        break;
      case "message_end": {
        const message = event.entry.model?.[0];
        if (message?.role !== "assistant") break;
        const stepId = `pi-entry:${String(event.entry.id ?? envelope.operationId)}`;
        const text = assistantText(message);
        if (text && text !== state.text) {
          state.text = text;
          translated.push(tokenEvent(text, envelope));
        }
        translated.push({
          type: "step_start",
          sandboxId: `pi:${envelope.sessionId}`,
          timestamp: envelope.timestamp,
          messageId: envelope.operationId,
          stepId,
        });
        translated.push({
          type: "step_finish",
          sandboxId: `pi:${envelope.sessionId}`,
          timestamp: envelope.timestamp,
          messageId: envelope.operationId,
          stepId,
          tokens: {
            input: message.usage.input,
            output: message.usage.output,
            ...(message.usage.reasoning === undefined
              ? {}
              : { reasoning: message.usage.reasoning }),
            cache: {
              read: message.usage.cacheRead,
              write: message.usage.cacheWrite,
            },
            total: message.usage.totalTokens,
          },
          reason: message.stopReason,
        });
        break;
      }
      case "tool_execution_start": {
        const current = {
          tool: event.toolName,
          args: event.args,
          output: "",
          ...(event.parentToolCallId
            ? { isSubtask: true, taskCallId: event.parentToolCallId }
            : {}),
        };
        tools.set(event.toolCallId, current);
        translated.push(toolEvent(current, event.toolCallId, "running", envelope));
        break;
      }
      case "tool_execution_update": {
        const current = tools.get(event.toolCallId) ?? {
          tool: event.toolName,
          args: {},
          output: "",
          ...(event.parentToolCallId
            ? { isSubtask: true, taskCallId: event.parentToolCallId }
            : {}),
        };
        if (event.output) {
          if ("set" in event.output) current.output = event.output.set;
          else {
            if (event.output.trimStart)
              current.output = current.output.slice(event.output.trimStart);
            if (event.output.append) current.output += event.output.append;
          }
        }
        tools.set(event.toolCallId, current);
        translated.push(toolEvent(current, event.toolCallId, "running", envelope));
        break;
      }
      case "tool_execution_end": {
        const current = tools.get(event.toolCallId) ?? {
          tool: event.toolName,
          args: {},
          output: "",
          ...(event.parentToolCallId
            ? { isSubtask: true, taskCallId: event.parentToolCallId }
            : {}),
        };
        const result = event.entry?.model?.[0];
        if (result?.role === "toolResult") {
          current.output = result.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("");
        }
        translated.push(
          toolEvent(
            current,
            event.toolCallId,
            event.result?.isError === true ||
              (result?.role === "toolResult" ? result.isError : event.result === undefined)
              ? "failed"
              : "completed",
            envelope
          )
        );
        tools.delete(event.toolCallId);
        break;
      }
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
    translated.push(tokenEvent(state.text, envelope));
  }
  return translated;
}

function snapshotToolStatus(snapshot: SnapshotEvent, entryId: unknown): "completed" | "failed" {
  if (entryId === undefined) return "failed";
  const entry = snapshot.entries.find((candidate) => candidate.id === entryId);
  const result = entry?.model?.[0];
  return result?.role === "toolResult" && !result.isError ? "completed" : "failed";
}

function tokenEvent(
  content: string,
  envelope: { sessionId: string; operationId: string; timestamp: number }
): Extract<SandboxIngressEvent, { type: "token" }> {
  return {
    type: "token",
    sandboxId: `pi:${envelope.sessionId}`,
    timestamp: envelope.timestamp,
    messageId: envelope.operationId,
    content,
    partId: envelope.operationId,
  };
}

function settledSnapshotEvents(
  snapshot: SnapshotEvent,
  state: PiEventTranslationState,
  envelope: { sessionId: string; operationId: string; timestamp: number }
): SandboxIngressEvent[] {
  let start = -1;
  for (let index = snapshot.entries.length - 1; index >= 0; index--) {
    if (snapshot.entries[index]?.model?.[0]?.role === "user") {
      start = index;
      break;
    }
  }
  if (start < 0) return [];
  const projected: SandboxIngressEvent[] = [];
  const calls = new Map<string, PiToolTranslationState>();
  for (const entry of snapshot.entries.slice(start + 1)) {
    const message = entry.model?.[0];
    if (message?.role === "assistant") {
      const text = assistantText(message);
      if (text) {
        state.text = text;
        projected.push(tokenEvent(text, envelope));
      }
      const stepId = `pi-entry:${String(entry.id ?? envelope.operationId)}`;
      projected.push({
        type: "step_start",
        sandboxId: `pi:${envelope.sessionId}`,
        timestamp: envelope.timestamp,
        messageId: envelope.operationId,
        stepId,
      });
      projected.push({
        type: "step_finish",
        sandboxId: `pi:${envelope.sessionId}`,
        timestamp: envelope.timestamp,
        messageId: envelope.operationId,
        stepId,
        tokens: {
          input: message.usage.input,
          output: message.usage.output,
          ...(message.usage.reasoning === undefined ? {} : { reasoning: message.usage.reasoning }),
          cache: { read: message.usage.cacheRead, write: message.usage.cacheWrite },
          total: message.usage.totalTokens,
        },
        reason: message.stopReason,
      });
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        calls.set(part.id, { tool: part.name, args: part.arguments, output: "" });
      }
      continue;
    }
    if (message?.role !== "toolResult") continue;
    const call = calls.get(message.toolCallId) ?? {
      tool: message.toolName,
      args: {},
      output: "",
    };
    call.output = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    projected.push(
      toolEvent(call, message.toolCallId, message.isError ? "failed" : "completed", envelope)
    );
  }
  return projected;
}

function assistantText(message: AssistantMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function latestAssistant(snapshot: SnapshotEvent): AssistantMessage | undefined {
  for (let index = snapshot.entries.length - 1; index >= 0; index--) {
    const message = snapshot.entries[index]?.model?.[0];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function toolCalls(message: AssistantMessage | undefined): Map<string, Record<string, unknown>> {
  const calls = new Map<string, Record<string, unknown>>();
  if (!message) return calls;
  for (const part of message.content) {
    if (part.type === "toolCall") calls.set(part.id, part.arguments);
  }
  return calls;
}

function toolEvent(
  state: PiToolTranslationState,
  callId: string,
  status: string,
  envelope: { sessionId: string; operationId: string; timestamp: number }
): Extract<SandboxIngressEvent, { type: "tool_call" }> {
  return {
    type: "tool_call",
    sandboxId: `pi:${envelope.sessionId}`,
    timestamp: envelope.timestamp,
    messageId: envelope.operationId,
    tool: state.tool,
    args: redactToolArguments(state.tool, state.args),
    callId,
    status,
    ...(state.output ? { output: redactToolOutput(state.tool, state.output) } : {}),
    ...(state.isSubtask ? { isSubtask: true } : {}),
    ...(state.taskCallId ? { taskCallId: state.taskCallId } : {}),
  };
}

function redactToolArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (tool === "write" && "content" in args) {
    return { path: args.path, content: REDACTED };
  }
  if (tool !== "edit" || !Array.isArray(args.edits)) return args;
  return {
    path: args.path,
    edits: args.edits.map((edit) =>
      typeof edit === "object" && edit !== null
        ? { oldText: REDACTED, newText: REDACTED }
        : REDACTED
    ),
  };
}

function redactToolOutput(tool: string, output: string): string {
  return tool === "write" || tool === "edit" ? REDACTED : output;
}
