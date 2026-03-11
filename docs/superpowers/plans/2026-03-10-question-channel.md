# Question/Clarification Channel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the OpenCode question tool so the LLM (especially in Plan mode) can ask users for clarification, with responses flowing back through our full stack: sandbox (OpenCode) -> bridge -> control plane -> web UI -> user answers -> reverse path -> OpenCode resumes.

**Architecture:** OpenCode's question tool (`src/tool/question.ts`) blocks LLM execution via a Promise, publishes a `question.asked` event on its Bus/SSE stream, and waits for a `POST /question/:requestID/reply` response. Our bridge already reads OpenCode's SSE stream for other events. We need to: (1) recognize `question.asked` events in the SSE stream, (2) emit a new `question` SandboxEvent to the control plane, (3) forward it to web clients, (4) render a question UI, (5) accept user answers, (6) route answers back through control plane -> bridge -> OpenCode HTTP API to unblock the LLM.

**Tech Stack:** TypeScript (shared, control-plane, web), Python (modal-infra), React 19, Cloudflare Workers

**Prerequisite:** Plan 1 (Agent Selection) should be implemented first since the question tool is most useful with the Plan agent.

**Timeout note:** OpenCode sends `server.heartbeat` events every 10 seconds on the SSE stream, which resets the bridge's inactivity deadline. This keeps the SSE connection alive while a question is pending. As a safety measure, the bridge also explicitly extends the deadline when a question event is detected.

**Reconnect limitation:** If the bridge WebSocket disconnects and reconnects while a question is pending, the in-memory `_pending_question_ids` set is lost. OpenCode's question will still block the LLM until the SSE inactivity timeout. This is acceptable — the user can click Stop to recover.

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `packages/shared/src/types/index.ts` | Add `question` SandboxEvent, `question_response` ClientMessage |
| Modify | `packages/modal-infra/src/sandbox/entrypoint.py` | Enable question tool |
| Modify | `packages/modal-infra/src/sandbox/bridge.py` | Parse `question.asked` SSE events, handle `question_response` commands, call OpenCode reply/reject API |
| Modify | `packages/control-plane/src/session/types.ts` | Add `QuestionResponseCommand` to `SandboxCommand` |
| Modify | `packages/control-plane/src/session/durable-object.ts` | Route question events to clients, forward responses to sandbox |
| Create | `packages/web/src/components/question-dock.tsx` | Question form UI component |
| Modify | `packages/web/src/hooks/use-session-socket.ts` | Handle question events, send responses |
| Modify | `packages/web/src/app/(app)/session/[id]/page.tsx` | Render question dock when question arrives |

---

## Chunk 1: Shared Types

### Task 1: Add question types to shared package

**Files:**
- Modify: `packages/shared/src/types/index.ts:161-279`

- [ ] **Step 1: Add `QuestionOption` and `QuestionInfo` types**

Before the `SandboxEvent` type (around line 160), add:

```typescript
// Question tool types (for LLM-to-user clarification)
export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}

export interface QuestionRequest {
  requestId: string;
  sessionId: string;
  questions: QuestionInfo[];
  tool?: { messageId: string; callId: string };
}
```

- [ ] **Step 2: Add `question` variant to `SandboxEvent` union**

After the `user_message` variant (line 252-263) and before the closing `;`, add:

```typescript
  | {
      type: "question";
      requestId: string;
      questions: QuestionInfo[];
      tool?: { messageId: string; callId: string };
      sandboxId: string;
      timestamp: number;
    }
```

- [ ] **Step 3: Add `question_response` and `question_reject` to `ClientMessage` union**

After the `fetch_history` variant (line 279), add:

```typescript
  | { type: "question_response"; requestId: string; answers: string[][] }
  | { type: "question_reject"; requestId: string }
```

The `answers` is an array of arrays of strings — each inner array is one question's selected answers (labels or custom text).

- [ ] **Step 4: Build shared package**

Run: `npm run build -w @open-inspect/shared`
Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat: add question/clarification types to shared package"
```

---

## Chunk 2: Enable Question Tool in Sandbox

### Task 2: Enable the OpenCode question tool

**Files:**
- Modify: `packages/modal-infra/src/sandbox/entrypoint.py:404-413`

- [ ] **Step 1: Enable question tool via env var**

At line 412, change:

```python
"OPENCODE_CLIENT": "serve",
```

To:

```python
"OPENCODE_CLIENT": "serve",
"OPENCODE_ENABLE_QUESTION_TOOL": "true",
```

OpenCode's tool registry (`registry.ts:101`) checks: `Flag.OPENCODE_ENABLE_QUESTION_TOOL`. When this flag is truthy, the question tool is registered regardless of client type.

- [ ] **Step 2: Update the comment above**

Replace lines 407-411:

```python
# Enable OpenCode's question tool for interactive user clarification.
# The bridge relays question.asked events to the control plane and
# forwards user answers back via POST /question/:requestID/reply.
# See: https://github.com/anomalyco/opencode/blob/19b1222cd/packages/opencode/src/tool/registry.ts#L100
```

- [ ] **Step 3: Commit**

```bash
git add packages/modal-infra/src/sandbox/entrypoint.py
git commit -m "feat: enable OpenCode question tool for user clarification"
```

---

## Chunk 3: Bridge — Question Event Forwarding

### Task 3: Parse `question.asked` events from OpenCode SSE

**Files:**
- Modify: `packages/modal-infra/src/sandbox/bridge.py`

The bridge's `_stream_opencode_response_sse` method (line 1050) reads all SSE events from OpenCode's `/event` endpoint. Currently it looks for `message.updated` events to process text/tool parts. We need to also detect `question.asked` events.

- [ ] **Step 1: Add question event handling in the SSE event loop**

Find the main SSE event processing loop in `_stream_opencode_response_sse`. After the existing event type checks (likely checking for `message.updated`, `session.updated`, etc.), add handling for `question.asked`:

```python
elif event_type == "question.asked":
    props = event.get("properties", {})
    question_event = {
        "type": "question",
        "requestId": props.get("id", ""),
        "questions": props.get("questions", []),
    }
    tool_info = props.get("tool")
    if tool_info:
        question_event["tool"] = {
            "messageId": tool_info.get("messageID", ""),
            "callId": tool_info.get("callID", ""),
        }
    yield question_event
```

This transforms the OpenCode Bus event into our `SandboxEvent` format.

- [ ] **Step 2: Store pending question request IDs for reply routing**

Add instance state to track pending questions:

```python
# In __init__ or class body:
self._pending_question_ids: set[str] = set()
```

In the question event handler above, also track it:

```python
self._pending_question_ids.add(props.get("id", ""))
```

- [ ] **Step 3: Run Python tests to ensure no regression**

Run: `cd packages/modal-infra && pytest tests/ -v`
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/modal-infra/src/sandbox/bridge.py
git commit -m "feat: parse question.asked SSE events from OpenCode"
```

---

### Task 4: Handle question_response commands from control plane

**Files:**
- Modify: `packages/modal-infra/src/sandbox/bridge.py:551-619`

- [ ] **Step 1: Add `question_response` handling in `_handle_command`**

In the `_handle_command` method (line 551), after the existing command type checks, add:

```python
elif cmd_type == "question_response":
    request_id = cmd.get("requestId", "")
    answers = cmd.get("answers", [])
    await self._handle_question_response(request_id, answers)

elif cmd_type == "question_reject":
    request_id = cmd.get("requestId", "")
    await self._handle_question_reject(request_id)
```

- [ ] **Step 2: Implement `_handle_question_response` method**

Add a new method after `_handle_prompt`:

```python
async def _handle_question_response(self, request_id: str, answers: list[list[str]]) -> None:
    """Forward user's question answers to OpenCode."""
    if not self.http_client:
        self.log.error("question_response.no_client", request_id=request_id)
        return

    url = f"{self.opencode_base_url}/question/{request_id}/reply"
    try:
        resp = await self.http_client.post(
            url,
            json={"answers": answers},
            timeout=self.OPENCODE_REQUEST_TIMEOUT,
        )
        if resp.status_code != 200:
            self.log.error(
                "question_response.error",
                request_id=request_id,
                status_code=resp.status_code,
                body=resp.text,
            )
        else:
            self.log.info("question_response.sent", request_id=request_id)
            self._pending_question_ids.discard(request_id)
    except Exception as e:
        self.log.error("question_response.exception", request_id=request_id, exc=e)
```

- [ ] **Step 3: Implement `_handle_question_reject` method**

```python
async def _handle_question_reject(self, request_id: str) -> None:
    """Reject/dismiss a pending question in OpenCode."""
    if not self.http_client:
        self.log.error("question_reject.no_client", request_id=request_id)
        return

    url = f"{self.opencode_base_url}/question/{request_id}/reject"
    try:
        resp = await self.http_client.post(
            url,
            timeout=self.OPENCODE_REQUEST_TIMEOUT,
        )
        if resp.status_code != 200:
            self.log.error(
                "question_reject.error",
                request_id=request_id,
                status_code=resp.status_code,
            )
        else:
            self.log.info("question_reject.sent", request_id=request_id)
            self._pending_question_ids.discard(request_id)
    except Exception as e:
        self.log.error("question_reject.exception", request_id=request_id, exc=e)
```

- [ ] **Step 4: Handle SSE inactivity timeout during question wait**

The bridge has an SSE inactivity timeout (120s by default). When a question is pending, the LLM is blocked — no SSE events will flow. The timeout needs to be extended or reset when a question is active.

Find where the SSE timeout is managed (line 1181: `deadline = asyncio.get_running_loop().time() + self.sse_inactivity_timeout`). When yielding a question event, extend the deadline:

```python
# After yielding a question event:
if timeout_ctx is not None:
    # Extend timeout — user may take a while to answer
    timeout_ctx.reschedule(loop.time() + self.QUESTION_WAIT_TIMEOUT)
```

Add a class constant:

```python
QUESTION_WAIT_TIMEOUT: float = 600.0  # 10 minutes for user to answer
```

Also, OpenCode sends heartbeat events on the SSE stream every 10 seconds (`server.heartbeat`), which should keep resetting the deadline. Verify this by checking if the SSE parse loop handles `server.heartbeat` events — if so, the timeout will already be reset on each heartbeat and this step may not be needed. But the explicit extension is safer.

- [ ] **Step 5: Run Python tests**

Run: `cd packages/modal-infra && pytest tests/ -v`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/modal-infra/src/sandbox/bridge.py
git commit -m "feat: handle question_response/reject commands and relay to OpenCode"
```

---

## Chunk 4: Control Plane — Question Routing

### Task 5: Add question command types and route through DO

**Files:**
- Modify: `packages/control-plane/src/session/types.ts:151-157`
- Modify: `packages/control-plane/src/session/durable-object.ts:952-1026`

- [ ] **Step 1: Add `QuestionResponseCommand` and `QuestionRejectCommand` to types**

In `types.ts`, after `PushCommand` (line 149), add:

```typescript
export interface QuestionResponseCommand {
  type: "question_response";
  requestId: string;
  answers: string[][];
}

export interface QuestionRejectCommand {
  type: "question_reject";
  requestId: string;
}
```

Update the `SandboxCommand` union (line 151-157) to include them:

```typescript
export type SandboxCommand =
  | PromptCommand
  | StopCommand
  | SnapshotCommand
  | ShutdownCommand
  | AckCommand
  | PushCommand
  | QuestionResponseCommand
  | QuestionRejectCommand;
```

- [ ] **Step 2: Handle `question` sandbox events in `processSandboxEvent`**

Find `processSandboxEvent` in `durable-object.ts`. The question event from the sandbox should be broadcast to all clients. It flows through the same `handleSandboxMessage` -> `processSandboxEvent` path as other events (line 982). Since `processSandboxEvent` already broadcasts `sandbox_event` messages for unknown event types, verify this works:

```typescript
// The question event arrives as a SandboxEvent and gets broadcast as:
// { type: "sandbox_event", event: { type: "question", requestId, questions, ... } }
```

No special handling should be needed — the existing broadcast path at `processSandboxEvent` should already forward it. Verify this by checking how other events are handled.

- [ ] **Step 3: Handle `question_response` and `question_reject` client messages**

In `handleClientMessage` (line 993-1026), add cases to the switch:

```typescript
case "question_response": {
  const sandboxWs = this.getSandboxSocket();
  if (sandboxWs) {
    this.wsManager.send(sandboxWs, {
      type: "question_response",
      requestId: data.requestId,
      answers: data.answers,
    });
  }
  break;
}

case "question_reject": {
  const sandboxWs = this.getSandboxSocket();
  if (sandboxWs) {
    this.wsManager.send(sandboxWs, {
      type: "question_reject",
      requestId: data.requestId,
    });
  }
  break;
}
```

This forwards user answers directly to the sandbox WebSocket, which the bridge receives as a command.

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane/src/session/types.ts packages/control-plane/src/session/durable-object.ts
git commit -m "feat: route question events and responses through control plane DO"
```

---

## Chunk 5: Web UI — Question Display and Response

### Task 6: Handle question events in the WebSocket hook

**Files:**
- Modify: `packages/web/src/hooks/use-session-socket.ts:170-200,549-586`

- [ ] **Step 1: Add question state**

Add state for the active question near the existing state declarations (around line 149):

```typescript
const [activeQuestion, setActiveQuestion] = useState<SandboxEvent | null>(null);
```

The `SandboxEvent` type now includes the `question` variant from our shared types changes.

- [ ] **Step 2: Handle question events in `processSandboxEvent`**

In the `processSandboxEvent` callback (line 170-200), add handling for the `question` type:

```typescript
} else if (event.type === "question") {
  setActiveQuestion(event);
  // Also add to events for history display
  setEvents((prev) => [...prev, event]);
}
```

- [ ] **Step 3: Clear active question on execution_complete**

In the `execution_complete` handler (line 179), also clear the question:

```typescript
} else if (event.type === "execution_complete") {
  setActiveQuestion(null);  // <-- add this
  // ... existing code
```

- [ ] **Step 4: Add sendQuestionResponse and sendQuestionReject functions**

After the `sendPrompt` function (line 586), add:

```typescript
const sendQuestionResponse = useCallback((requestId: string, answers: string[][]) => {
  if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
  wsRef.current.send(
    JSON.stringify({ type: "question_response", requestId, answers })
  );
  setActiveQuestion(null);
}, []);

const sendQuestionReject = useCallback((requestId: string) => {
  if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
  wsRef.current.send(
    JSON.stringify({ type: "question_reject", requestId })
  );
  setActiveQuestion(null);
}, []);
```

- [ ] **Step 5: Return new state and functions from the hook**

Add to the hook's return object:

```typescript
return {
  // ... existing returns
  activeQuestion,
  sendQuestionResponse,
  sendQuestionReject,
};
```

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/hooks/use-session-socket.ts
git commit -m "feat: handle question events and response functions in session hook"
```

---

### Task 7: Create question dock UI component

**Files:**
- Create: `packages/web/src/components/question-dock.tsx`

- [ ] **Step 1: Create the QuestionDock component**

```tsx
"use client";

import { useState } from "react";
import type { QuestionInfo } from "@open-inspect/shared";

interface QuestionDockProps {
  requestId: string;
  questions: QuestionInfo[];
  onSubmit: (requestId: string, answers: string[][]) => void;
  onDismiss: (requestId: string) => void;
}

export function QuestionDock({ requestId, questions, onSubmit, onDismiss }: QuestionDockProps) {
  // Each question gets an array of selected answers
  const [answers, setAnswers] = useState<string[][]>(() => questions.map(() => []));
  const [customInputs, setCustomInputs] = useState<string[]>(() => questions.map(() => ""));

  const toggleOption = (questionIdx: number, label: string, multiple: boolean) => {
    setAnswers((prev) => {
      const next = [...prev];
      const current = next[questionIdx] ?? [];
      if (multiple) {
        next[questionIdx] = current.includes(label)
          ? current.filter((a) => a !== label)
          : [...current, label];
      } else {
        next[questionIdx] = current.includes(label) ? [] : [label];
      }
      return next;
    });
  };

  const handleCustomInput = (questionIdx: number, value: string) => {
    setCustomInputs((prev) => {
      const next = [...prev];
      next[questionIdx] = value;
      return next;
    });
  };

  const handleSubmit = () => {
    const finalAnswers = questions.map((_, i) => {
      const selected = answers[i] ?? [];
      const custom = customInputs[i]?.trim();
      return custom ? [...selected, custom] : selected;
    });
    onSubmit(requestId, finalAnswers);
  };

  const hasAnyAnswer = answers.some((a) => a.length > 0) || customInputs.some((c) => c.trim());

  return (
    <div className="border border-border rounded-lg bg-background-secondary p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Agent has questions</h3>
        <button
          onClick={() => onDismiss(requestId)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </button>
      </div>

      {questions.map((q, qi) => (
        <div key={qi} className="space-y-2">
          <p className="text-sm font-medium">{q.question}</p>
          <div className="flex flex-wrap gap-2">
            {q.options.map((opt) => {
              const selected = (answers[qi] ?? []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  onClick={() => toggleOption(qi, opt.label, q.multiple ?? false)}
                  className={`px-3 py-1.5 text-sm rounded-md border transition ${
                    selected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:border-primary/50"
                  }`}
                  title={opt.description}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            placeholder="Or type a custom answer..."
            value={customInputs[qi] ?? ""}
            onChange={(e) => handleCustomInput(qi, e.target.value)}
            className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      ))}

      <button
        onClick={handleSubmit}
        disabled={!hasAnyAnswer}
        className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Submit answers
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/question-dock.tsx
git commit -m "feat: create QuestionDock component for user clarification UI"
```

---

### Task 8: Integrate QuestionDock into the session page

**Files:**
- Modify: `packages/web/src/app/(app)/session/[id]/page.tsx`

- [ ] **Step 1: Destructure question state from the hook**

Find where the hook is called and add the new returns:

```typescript
const {
  // ... existing destructured values
  activeQuestion,
  sendQuestionResponse,
  sendQuestionReject,
} = useSessionSocket(sessionId);
```

- [ ] **Step 2: Render the QuestionDock above the input form and disable prompt input**

Find the `<footer>` element (around line 854) that wraps the input form. **Before** the `<form>` element (NOT inside it), add:

```tsx
{activeQuestion && activeQuestion.type === "question" && (
  <div className="px-4 pb-2">
    <QuestionDock
      requestId={activeQuestion.requestId}
      questions={activeQuestion.questions}
      onSubmit={sendQuestionResponse}
      onDismiss={sendQuestionReject}
    />
  </div>
)}
```

Import the component at the top of the file:

```typescript
import { QuestionDock } from "@/components/question-dock";
```

Also disable the prompt input and send button while a question is active. In the `handleSubmit` function (around line 277), add:

```typescript
if (!prompt.trim() || isProcessing || activeQuestion) return;
```

And disable the textarea and send button when `activeQuestion` is truthy (add `disabled={!!activeQuestion}` or `!!activeQuestion || isProcessing` alongside existing disabled props).

- [ ] **Step 3: Render question events in the event timeline**

In the `EventItem` component (around line 1162), add a case for question events so they appear in history:

```tsx
if (event.type === "question") {
  return (
    <div className="text-sm text-muted-foreground italic py-2">
      Agent asked {event.questions.length} question{event.questions.length > 1 ? "s" : ""} for clarification
    </div>
  );
}
```

- [ ] **Step 4: Verify UI renders**

Run: `npm run dev -w @open-inspect/web`
Open a session, verify no rendering errors. (The question dock won't appear until a question event arrives.)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/(app)/session/[id]/page.tsx
git commit -m "feat: integrate QuestionDock into session page"
```

---

## Chunk 6: Timeout and Edge Cases

### Task 9: Handle timeout and cleanup edge cases

**Files:**
- Modify: `packages/modal-infra/src/sandbox/bridge.py`

- [ ] **Step 1: Reject pending questions on execution stop**

When the user clicks "Stop" (which sends a `stop` command), any pending question should be auto-rejected so the LLM doesn't hang.

In the `_handle_stop` method (find it near `_handle_command`), add:

```python
# Reject any pending questions so the LLM doesn't block
for request_id in list(self._pending_question_ids):
    await self._handle_question_reject(request_id)
```

- [ ] **Step 2: Clean up pending questions on session shutdown**

Similar cleanup in the shutdown handler.

- [ ] **Step 3: Add `question` to non-critical events (NOT to CRITICAL_EVENT_TYPES)**

Verify that `"question"` is NOT added to `CRITICAL_EVENT_TYPES` (line ~145-150). Question events should be sent immediately but don't need ack tracking since they're UI-transient.

- [ ] **Step 4: Run all Python tests**

Run: `cd packages/modal-infra && pytest tests/ -v`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add packages/modal-infra/src/sandbox/bridge.py
git commit -m "fix: auto-reject pending questions on stop/shutdown"
```

---

## Chunk 7: Integration Verification

### Task 10: End-to-end verification

- [ ] **Step 1: Build all packages**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 2: Run all TypeScript tests**

```bash
npm test -w @open-inspect/control-plane
npm test -w @open-inspect/web
```

- [ ] **Step 3: Run Python tests**

```bash
cd packages/modal-infra && pytest tests/ -v
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 5: Lint**

```bash
npm run lint:fix
```

- [ ] **Step 6: Final commit if any fixes**

```bash
git add -A && git commit -m "chore: lint fixes for question channel feature"
```

- [ ] **Step 7: Manual E2E test plan**

1. Deploy to staging or run locally
2. Create a session with the **Plan** agent selected
3. Send a prompt like "Help me plan a refactor of the authentication system"
4. Verify the Plan agent uses the question tool — a question dock should appear
5. Select options and/or type custom answers, click Submit
6. Verify the LLM receives the answers and continues
7. Try dismissing a question — verify the LLM stops gracefully
8. Try clicking Stop while a question is pending — verify it doesn't hang
