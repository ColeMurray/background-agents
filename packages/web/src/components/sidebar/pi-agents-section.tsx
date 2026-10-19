"use client";

import { useRef, useState, type RefObject } from "react";
import type { SessionCapabilities } from "@/lib/session-capabilities";
import { formatSessionCost } from "@/lib/session-cost";
import { usePiAgents, type PiAgentSnapshot } from "@/hooks/use-pi-agents";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface PiAgentsSectionProps {
  sessionId: string;
  capabilities: SessionCapabilities;
}

type ConfirmedAction =
  | { kind: "fork"; agent: PiAgentSnapshot }
  | { kind: "reset"; agent: PiAgentSnapshot }
  | { kind: "handoff"; agent: PiAgentSnapshot; message: string }
  | { kind: "compact"; agent: PiAgentSnapshot };
type AgentAction = Parameters<ReturnType<typeof usePiAgents>["run"]>[0];
type ExecuteAgentAction = (action: AgentAction, success: string, clear?: boolean) => Promise<void>;

const actionClass =
  "min-h-11 rounded-sm border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

export function PiAgentsSection({ sessionId, capabilities }: PiAgentsSectionProps) {
  const { agents, error, isLoading, isValidating, run } = usePiAgents(sessionId, true);
  if (isLoading) return <p className="text-xs text-muted-foreground">Loading Pi agents…</p>;
  if (error)
    return (
      <p role="alert" className="text-xs text-destructive">
        {error}
      </p>
    );
  if (agents.length === 0)
    return <p className="text-xs text-muted-foreground">No Pi conversations are available.</p>;
  return (
    <PiAgentsWorkspace
      agents={agents}
      isValidating={isValidating}
      capabilities={capabilities}
      run={run}
    />
  );
}

function PiAgentsWorkspace({
  agents,
  isValidating,
  capabilities,
  run,
}: {
  agents: PiAgentSnapshot[];
  isValidating: boolean;
  capabilities: SessionCapabilities;
  run: ReturnType<typeof usePiAgents>["run"];
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [actionFailed, setActionFailed] = useState(false);
  const [confirmedAction, setConfirmedAction] = useState<ConfirmedAction | null>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const selected = agents.find((agent) => agent.conversationId === selectedId) ?? agents[0]!;

  const execute = async (action: Parameters<typeof run>[0], success: string, clear = false) => {
    setPending(true);
    setAnnouncement("");
    setActionFailed(false);
    try {
      await run(action);
      if (clear) setMessage("");
      setAnnouncement(success);
      messageRef.current?.focus();
    } catch (actionError) {
      setActionFailed(true);
      setAnnouncement(actionError instanceof Error ? actionError.message : "Agent action failed");
    } finally {
      setPending(false);
    }
  };

  const executeConfirmed = async () => {
    const action = confirmedAction;
    setConfirmedAction(null);
    if (!action) return;
    const plan = confirmedActionPlan(action);
    if (plan) await execute(plan.action, plan.success, plan.clear);
  };

  const canSend = capabilities.collaborate && message.trim().length > 0 && !pending;
  const confirmCopy = confirmedAction ? confirmationCopy(confirmedAction.kind) : null;

  return (
    <section aria-labelledby="pi-agents-heading" className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 id="pi-agents-heading" className="text-sm font-semibold">
          Pi agents
        </h3>
        <span className="text-[11px] text-muted-foreground" aria-live="polite">
          {isValidating
            ? "Updating"
            : `${agents.length} conversation${agents.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <AgentPicker agents={agents} selected={selected} onSelect={setSelectedId} />
      <AgentSummary agent={selected} />
      {capabilities.collaborate && (
        <AgentMessageComposer
          agent={selected}
          message={message}
          messageRef={messageRef}
          canSend={canSend}
          onMessageChange={setMessage}
          execute={execute}
        />
      )}
      <AgentConversationActions
        agent={selected}
        capabilities={capabilities}
        message={message}
        pending={pending}
        onConfirm={setConfirmedAction}
      />
      {capabilities.lifecycle && selected.tasks.length > 0 && (
        <AgentTaskList agent={selected} pending={pending} execute={execute} />
      )}

      {announcement && (
        <p
          role={actionFailed ? "alert" : "status"}
          aria-live={actionFailed ? "assertive" : "polite"}
          aria-atomic="true"
          className={`text-xs ${actionFailed ? "text-destructive" : "text-muted-foreground"}`}
        >
          {announcement}
        </p>
      )}

      <AlertDialog
        open={confirmedAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmedAction(null);
        }}
      >
        <AlertDialogContent className="motion-reduce:animate-none motion-reduce:transition-none">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmCopy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmCopy?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current state</AlertDialogCancel>
            <AlertDialogAction onClick={() => void executeConfirmed()}>
              {confirmCopy?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function confirmedActionPlan(
  confirmed: ConfirmedAction
): { action: AgentAction; success: string; clear?: boolean } | null {
  switch (confirmed.kind) {
    case "fork":
      return confirmed.agent.lastMessage
        ? {
            action: {
              action: "fork",
              conversationId: confirmed.agent.conversationId,
              entryId: confirmed.agent.lastMessage.entryId,
            },
            success: "Agent conversation forked",
          }
        : null;
    case "reset":
      return {
        action: { action: "reset", conversationId: confirmed.agent.conversationId },
        success: "Agent context reset",
      };
    case "handoff":
      return {
        action: {
          action: "handoff",
          conversationId: confirmed.agent.conversationId,
          handoff: confirmed.message,
        },
        success: "Agent context handed off",
        clear: true,
      };
    case "compact":
      return {
        action: { action: "compact", conversationId: confirmed.agent.conversationId },
        success: "Compaction started",
      };
  }
}

function AgentPicker({
  agents,
  selected,
  onSelect,
}: {
  agents: PiAgentSnapshot[];
  selected: PiAgentSnapshot;
  onSelect: (conversationId: number) => void;
}) {
  return (
    <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Pi conversations">
      {agents.map((agent, index) => {
        const active = agent.conversationId === selected.conversationId;
        return (
          <li key={agent.conversationId}>
            <button
              type="button"
              aria-pressed={active}
              aria-label={`${index === 0 ? "Primary" : `Child ${index}`} agent, ${agent.status}`}
              onClick={() => onSelect(agent.conversationId)}
              className={`min-h-11 min-w-24 rounded-sm border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                active ? "border-accent bg-accent-muted" : "border-border hover:bg-muted"
              }`}
            >
              <span className="block font-medium">
                {index === 0 ? "Primary" : `Child ${index}`}
              </span>
              <span className="mt-0.5 block capitalize text-muted-foreground">{agent.status}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function AgentSummary({ agent }: { agent: PiAgentSnapshot }) {
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <span>Status: {agent.status}</span>
        <span>{agent.queued} queued</span>
        <span>{agent.tasks.length} active tasks</span>
        <span>{agent.usage.usage.total.toLocaleString()} tokens</span>
        <span>{formatSessionCost(agent.usage.costUsd)}</span>
      </div>
      {agent.lastMessage && (
        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-sm bg-muted px-3 py-2 text-muted-foreground">
          <span className="sr-only">Last agent message: </span>
          {agent.lastMessage.text}
        </p>
      )}
    </div>
  );
}

function AgentMessageComposer({
  agent,
  message,
  messageRef,
  canSend,
  onMessageChange,
  execute,
}: {
  agent: PiAgentSnapshot;
  message: string;
  messageRef: RefObject<HTMLTextAreaElement | null>;
  canSend: boolean;
  onMessageChange: (message: string) => void;
  execute: ExecuteAgentAction;
}) {
  const send = (action: "send" | "follow_up" | "steer", success: string) =>
    execute({ action, conversationId: agent.conversationId, content: message }, success, true);
  return (
    <div className="space-y-2">
      <label htmlFor="pi-agent-message" className="text-xs font-medium">
        Message selected agent
      </label>
      <textarea
        ref={messageRef}
        id="pi-agent-message"
        value={message}
        maxLength={20_000}
        rows={3}
        onChange={(event) => onMessageChange(event.target.value)}
        className="w-full resize-y rounded-sm border border-border bg-input px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={actionClass}
          disabled={!canSend || agent.status !== "idle"}
          onClick={() => void send("send", "Message sent")}
        >
          Send
        </button>
        <button
          type="button"
          className={actionClass}
          disabled={!canSend}
          onClick={() => void send("follow_up", "Follow-up queued")}
        >
          Follow up now
        </button>
        <button
          type="button"
          className={actionClass}
          disabled={!canSend || agent.status !== "active"}
          onClick={() => void send("steer", "Steering sent")}
        >
          Steer
        </button>
      </div>
    </div>
  );
}

function AgentConversationActions({
  agent,
  capabilities,
  message,
  pending,
  onConfirm,
}: {
  agent: PiAgentSnapshot;
  capabilities: SessionCapabilities;
  message: string;
  pending: boolean;
  onConfirm: (action: ConfirmedAction) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Conversation actions">
      {capabilities.collaborate && agent.lastMessage && (
        <button
          type="button"
          className={actionClass}
          disabled={pending}
          onClick={() => onConfirm({ kind: "fork", agent })}
        >
          Fork
        </button>
      )}
      {capabilities.collaborate && (
        <button
          type="button"
          className={actionClass}
          disabled={pending}
          onClick={() => onConfirm({ kind: "compact", agent })}
        >
          Compact
        </button>
      )}
      {capabilities.lifecycle && (
        <>
          <button
            type="button"
            className={actionClass}
            disabled={pending}
            onClick={() => onConfirm({ kind: "reset", agent })}
          >
            Reset
          </button>
          <button
            type="button"
            className={actionClass}
            disabled={!message.trim() || pending}
            onClick={() => onConfirm({ kind: "handoff", agent, message: message.trim() })}
          >
            Handoff
          </button>
        </>
      )}
    </div>
  );
}

function AgentTaskList({
  agent,
  pending,
  execute,
}: {
  agent: PiAgentSnapshot;
  pending: boolean;
  execute: ExecuteAgentAction;
}) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium">Active tasks</h4>
      <ul className="space-y-1.5">
        {agent.tasks.map((task) => (
          <li key={task.id} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate">
              {task.kind} · {task.phase ?? task.status}
            </span>
            <button
              type="button"
              className={actionClass}
              disabled={pending || task.abortRequested}
              aria-label={`Cancel ${task.kind} task ${task.id}`}
              onClick={() =>
                void execute({ action: "cancel_exact", taskId: task.id }, "Cancellation requested")
              }
            >
              Cancel
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function confirmationCopy(kind: ConfirmedAction["kind"]) {
  switch (kind) {
    case "fork":
      return {
        title: "Fork this conversation?",
        description:
          "A new child conversation will start from the selected agent’s latest message.",
        action: "Fork conversation",
      };
    case "compact":
      return {
        title: "Compact this conversation?",
        description: "Pi will summarize older context while preserving the durable transcript.",
        action: "Start compaction",
      };
    case "reset":
      return {
        title: "Reset this conversation?",
        description: "The next turn will start with a fresh active context.",
        action: "Reset context",
      };
    case "handoff":
      return {
        title: "Hand off with this message?",
        description: "The current context will reset and the message will seed the next turn.",
        action: "Hand off",
      };
  }
}
