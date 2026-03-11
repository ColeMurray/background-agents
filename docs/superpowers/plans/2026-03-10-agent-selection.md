# Agent Selection (Build vs Plan) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose between "Build" and "Plan" agents in the web UI, threading the selection through the control plane into the sandbox so OpenCode runs with the correct agent context.

**Architecture:** The `agent` field follows the exact same path as the existing `model` field: web UI state -> WebSocket prompt message -> control plane message queue -> sandbox PromptCommand -> bridge -> OpenCode HTTP API. OpenCode already supports `"agent": "plan"` or `"agent": "build"` in its `POST /session/:sessionID/prompt_async` endpoint (via `PromptInput`). We just need to plumb it through.

**Tech Stack:** TypeScript (shared, control-plane, web), Python (modal-infra), React 19, Cloudflare Workers

**Storage note:** Session data lives in DO-local SQLite (not D1). Schema changes use the `MIGRATIONS` array in `packages/control-plane/src/session/schema.ts`. The D1 `sessions` table is a query-only index and does NOT need an `agent` column.

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `packages/shared/src/models.ts` | Add agent constants and validation |
| Modify | `packages/shared/src/types/index.ts` | Add `agent` to `ClientMessage`, `SessionState` |
| Modify | `packages/control-plane/src/session/types.ts` | Add `agent` to `PromptCommand`, `SessionRow`, `MessageRow`, `CreateMessageData` |
| Modify | `packages/control-plane/src/session/schema.ts` | DO SQLite migration to add `agent` column to `session` table |
| Modify | `packages/control-plane/src/session/repository.ts` | Add `agent` to `UpsertSessionData`, `upsertSession` SQL, `createMessage` SQL |
| Modify | `packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts` | Accept and validate `agent` in `InitRequest` |
| Modify | `packages/control-plane/src/session/message-queue.ts` | Thread `agent` into message storage and command building |
| Modify | `packages/control-plane/src/session/durable-object.ts` | Include `agent` in `getSessionState()` |
| Modify | `packages/web/src/hooks/use-session-socket.ts` | Add `agent` param to `sendPrompt` |
| Modify | `packages/web/src/app/(app)/session/[id]/page.tsx` | Agent picker UI + state |
| Modify | `packages/web/src/app/(app)/page.tsx` | Pass agent on session creation |
| Modify | `packages/web/src/app/api/sessions/route.ts` | Forward agent to control plane |
| Modify | `packages/modal-infra/src/sandbox/bridge.py` | Include `agent` in OpenCode prompt request |

---

## Chunk 1: Shared Types and Constants

### Task 1: Add agent constants to shared package

**Files:**
- Modify: `packages/shared/src/models.ts:33`
- Modify: `packages/shared/src/types/index.ts:269-275,343-363`

- [ ] **Step 1: Add agent constants to `models.ts`**

After the `DEFAULT_MODEL` constant (line 33), add:

```typescript
// Agent types
export const VALID_AGENTS = ["build", "plan"] as const;
export type ValidAgent = (typeof VALID_AGENTS)[number];
export const DEFAULT_AGENT: ValidAgent = "build";

export function isValidAgent(agent: string): agent is ValidAgent {
  return (VALID_AGENTS as readonly string[]).includes(agent);
}

export function getValidAgentOrDefault(agent: string | undefined): ValidAgent {
  if (agent && isValidAgent(agent)) return agent;
  return DEFAULT_AGENT;
}
```

- [ ] **Step 2: Add `agent` to `ClientMessage` prompt variant in `types/index.ts`**

In the prompt variant (lines 269-275), add `agent` after `reasoningEffort`:

```typescript
  | {
      type: "prompt";
      content: string;
      model?: string;
      reasoningEffort?: string;
      agent?: string;
      attachments?: Attachment[];
    }
```

- [ ] **Step 3: Add `agent` to `SessionState` in `types/index.ts`**

In the `SessionState` interface (line 343), after `reasoningEffort?: string;` (line 355), add:

```typescript
  agent?: string;
```

- [ ] **Step 4: Build shared package and verify no type errors**

Run: `npm run build -w @open-inspect/shared`
Expected: Clean build, no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/models.ts packages/shared/src/types/index.ts
git commit -m "feat: add agent type constants and thread agent through shared types"
```

---

### Task 2: Add agent to control-plane types and DO schema

**Files:**
- Modify: `packages/control-plane/src/session/types.ts:21-41,59-73,115-127`
- Modify: `packages/control-plane/src/session/schema.ts:10-30,157-368`
- Modify: `packages/control-plane/src/session/repository.ts:58-74,119-130,226-246,564-579`

- [ ] **Step 1: Add `agent` to `SessionRow` interface**

In `types.ts`, at line 34 (after `reasoning_effort: string | null;`), add:

```typescript
  agent: string; // Agent type (e.g., "build", "plan")
```

- [ ] **Step 2: Add `agent` to `MessageRow` interface**

In `types.ts`, at line 66 (after `reasoning_effort: string | null;`), add:

```typescript
  agent: string | null; // Agent type for per-message override
```

- [ ] **Step 3: Add `agent` to `PromptCommand` interface**

In `types.ts`, at line 120 (after `reasoningEffort?: string;`), add:

```typescript
  agent?: string; // Agent type for per-message override (e.g., "build", "plan")
```

- [ ] **Step 4: Add `agent` to `UpsertSessionData` interface**

In `repository.ts`, at line 67 (after `reasoningEffort?: string | null;`), add:

```typescript
  agent?: string;
```

- [ ] **Step 5: Add `agent` to `CreateMessageData` interface**

In `repository.ts`, at line 125 (after `reasoningEffort?: string | null;`), add:

```typescript
  agent?: string | null;
```

- [ ] **Step 6: Update `upsertSession` SQL in repository**

In `repository.ts`, the `upsertSession` method (lines 226-246) uses `INSERT OR REPLACE`. Add `agent` to both the column list and VALUES:

```typescript
upsertSession(data: UpsertSessionData): void {
  this.sql.exec(
    `INSERT OR REPLACE INTO session (id, session_name, title, repo_owner, repo_name, repo_id, base_branch, model, reasoning_effort, agent, status, parent_session_id, spawn_source, spawn_depth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    data.id,
    data.sessionName,
    data.title,
    data.repoOwner,
    data.repoName,
    data.repoId ?? null,
    data.baseBranch ?? "main",
    data.model,
    data.reasoningEffort ?? null,
    data.agent ?? "build",
    data.status,
    data.parentSessionId ?? null,
    data.spawnSource ?? "user",
    data.spawnDepth ?? 0,
    data.createdAt,
    data.updatedAt
  );
}
```

- [ ] **Step 7: Update `createMessage` SQL in repository**

In `repository.ts`, the `createMessage` method (lines 564-579) needs `agent` added:

```typescript
createMessage(data: CreateMessageData): void {
  this.sql.exec(
    `INSERT INTO messages (id, author_id, content, source, model, reasoning_effort, agent, attachments, callback_context, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    data.id,
    data.authorId,
    data.content,
    data.source,
    data.model ?? null,
    data.reasoningEffort ?? null,
    data.agent ?? null,
    data.attachments ?? null,
    data.callbackContext ?? null,
    data.status,
    data.createdAt
  );
}
```

- [ ] **Step 8: Add DO SQLite migration in `schema.ts`**

Session data lives in DO-local SQLite, NOT D1. Add `agent` to the `SCHEMA_SQL` `session` table (line 22, after the `reasoning_effort` column):

```sql
  agent TEXT DEFAULT 'build',                     -- Agent type (build, plan)
```

Then append a new migration to the `MIGRATIONS` array (after migration 28 at line 367):

```typescript
  {
    id: 29,
    description: "Add agent to session",
    run: `ALTER TABLE session ADD COLUMN agent TEXT DEFAULT 'build'`,
  },
```

No migration needed for the `messages` table — the messages `CREATE TABLE` already needs updating in `SCHEMA_SQL` (add `agent TEXT,` after `reasoning_effort TEXT,` at line 58), and a second migration:

```typescript
  {
    id: 30,
    description: "Add agent to messages",
    run: `ALTER TABLE messages ADD COLUMN agent TEXT`,
  },
```

- [ ] **Step 9: Update `getSessionState()` in `durable-object.ts`**

In `durable-object.ts`, the `getSessionState` method (lines 1467-1494) builds the `SessionState` object. After `reasoningEffort` (around line 1488), add:

```typescript
agent: session?.agent ?? "build",
```

- [ ] **Step 10: Verify typecheck passes**

Run: `npm run typecheck`
Expected: May still have errors in lifecycle handler and message queue — fixed in next tasks.

- [ ] **Step 11: Commit**

```bash
git add packages/control-plane/src/session/types.ts packages/control-plane/src/session/schema.ts packages/control-plane/src/session/repository.ts packages/control-plane/src/session/durable-object.ts
git commit -m "feat: add agent field to DO schema, types, and repository"
```

---

## Chunk 2: Control Plane Plumbing

### Task 3: Thread agent through session lifecycle and message queue

**Files:**
- Modify: `packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts:5,9-31,89-116`
- Modify: `packages/control-plane/src/session/message-queue.ts:180-321`

- [ ] **Step 1: Add import for `getValidAgentOrDefault`**

In `session-lifecycle.handler.ts`, at line 5 (where `getValidModelOrDefault` and `isValidModel` are imported from `"../../../utils/models"`), add `getValidAgentOrDefault` to the same import.

Note: `getValidModelOrDefault` is imported from `"../../../utils/models"` which re-exports from shared. Add the new function to that utils module if it doesn't re-export it, OR import directly from `@open-inspect/shared`. Check how other handlers do it.

- [ ] **Step 2: Add `agent` to `InitRequest` interface**

In `session-lifecycle.handler.ts`, at line 18 (after `reasoningEffort?: string;`), add:

```typescript
  agent?: string;
```

- [ ] **Step 3: Validate and store agent in `init()` handler**

After the `reasoningEffort` validation (line 97), add:

```typescript
const agent = getValidAgentOrDefault(body.agent);
```

- [ ] **Step 4: Pass `agent` to `upsertSession` call**

In the `upsertSession` call (line 100-116), add `agent` after `reasoningEffort` (line 109):

```typescript
agent,
```

- [ ] **Step 5: Thread agent through message queue — store on message**

In `message-queue.ts`, find the `createMessage` call (around line 199). Add `agent`:

```typescript
this.deps.repository.createMessage({
  id: messageId,
  authorId: participant.id,
  content: data.content,
  source: "web",
  model: messageModel,
  reasoningEffort: messageReasoningEffort,
  agent: data.agent ?? null,
  attachments: storedAttachments,
  status: "pending",
  createdAt: now,
});
```

- [ ] **Step 6: Thread agent into SandboxCommand**

In `message-queue.ts`, in the command building (lines 309-321), add `agent` after `reasoningEffort`:

```typescript
const command: SandboxCommand = {
  type: "prompt",
  messageId: message.id,
  content: message.content,
  model: resolvedModel,
  reasoningEffort: resolvedEffort,
  agent: message.agent || session?.agent || "build",
  author: {
    userId: author?.user_id ?? "unknown",
    scmName: author?.scm_name ?? null,
    scmEmail: author?.scm_email ?? null,
  },
  attachments,
};
```

Resolution priority: per-message agent > session agent > default "build".

- [ ] **Step 7: Verify typecheck**

Run: `npm run typecheck`
Expected: Clean (all types now aligned).

- [ ] **Step 8: Run control-plane tests**

Run: `npm test -w @open-inspect/control-plane`
Expected: All pass.

- [ ] **Step 9: Commit**

```bash
git add packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts packages/control-plane/src/session/message-queue.ts
git commit -m "feat: thread agent through session init and message queue"
```

---

## Chunk 3: Modal/Bridge Layer

### Task 4: Thread agent through bridge to OpenCode

**Files:**
- Modify: `packages/modal-infra/src/sandbox/bridge.py:621-696,925-1003,1050-1078`

- [ ] **Step 1: Extract `agent` from prompt command in `_handle_prompt`**

At line 627 (after `reasoning_effort = cmd.get("reasoningEffort")`), add:

```python
agent = cmd.get("agent")
```

- [ ] **Step 2: Pass `agent` to `_stream_opencode_response_sse`**

Update the call at line 656-657:

```python
async for event in self._stream_opencode_response_sse(
    message_id, content, model, reasoning_effort, attachments, agent=agent
):
```

- [ ] **Step 3: Add `agent` parameter to `_stream_opencode_response_sse`**

At line 1050, add `agent` parameter after `attachments`:

```python
async def _stream_opencode_response_sse(
    self,
    message_id: str,
    content: str,
    model: str | None = None,
    reasoning_effort: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    agent: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
```

- [ ] **Step 4: Pass `agent` to `_build_prompt_request_body`**

At lines 1076-1078, update the call:

```python
request_body = self._build_prompt_request_body(
    content, model, opencode_message_id, reasoning_effort, attachments, agent=agent
)
```

- [ ] **Step 5: Add `agent` to `_build_prompt_request_body` and include in request body**

Update the method signature at line 925:

```python
def _build_prompt_request_body(
    self,
    content: str,
    model: str | None,
    opencode_message_id: str | None = None,
    reasoning_effort: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    agent: str | None = None,
) -> dict[str, Any]:
```

After line 1001 (`request_body["model"] = model_spec`), outside the `if model:` block, add:

```python
if agent:
    request_body["agent"] = agent
```

This sends the agent to OpenCode's `POST /session/:sessionID/prompt_async` endpoint, which accepts it as part of `PromptInput`.

- [ ] **Step 6: Run bridge tests**

Run: `cd packages/modal-infra && pytest tests/ -v`
Expected: All existing tests pass (new field is optional).

- [ ] **Step 7: Commit**

```bash
git add packages/modal-infra/src/sandbox/bridge.py
git commit -m "feat: thread agent selection from prompt command to OpenCode API"
```

---

## Chunk 4: Web UI

### Task 5: Add agent to sendPrompt hook

**Files:**
- Modify: `packages/web/src/hooks/use-session-socket.ts:549-586`

- [ ] **Step 1: Add `agent` parameter to `sendPrompt`**

Update the function signature at line 549:

```typescript
const sendPrompt = useCallback((content: string, model?: string, reasoningEffort?: string, attachments?: Attachment[], agent?: string) => {
```

- [ ] **Step 2: Include `agent` in the WebSocket message**

At lines 577-585, add `agent`:

```typescript
wsRef.current.send(
  JSON.stringify({
    type: "prompt",
    content,
    model,
    reasoningEffort,
    agent,
    ...(attachments?.length ? { attachments } : {}),
  })
);
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/hooks/use-session-socket.ts
git commit -m "feat: add agent param to sendPrompt WebSocket hook"
```

---

### Task 6: Add agent picker UI to session page

**Files:**
- Modify: `packages/web/src/app/(app)/session/[id]/page.tsx:242,281,1012-1013`

- [ ] **Step 1: Add agent state**

After line 242 (`const [selectedModel, setSelectedModel] = ...`), add:

```typescript
const [selectedAgent, setSelectedAgent] = useState<string>("build");
```

- [ ] **Step 2: Pass agent to sendPrompt call**

Update line 281:

```typescript
sendPrompt(prompt, selectedModel, reasoningEffort, attachments.length > 0 ? attachments : undefined, selectedAgent);
```

- [ ] **Step 3: Sync agent from session state**

Add a new `useEffect` near the existing model sync (around line 268-275):

```typescript
useEffect(() => {
  if (sessionState?.agent) {
    setSelectedAgent(sessionState.agent);
  }
}, [sessionState?.agent]);
```

- [ ] **Step 4: Replace the hardcoded "build agent" label with a dropdown**

Replace line 1013:
```typescript
<span className="hidden sm:inline text-sm text-muted-foreground">build agent</span>
```

With an agent selector using the existing `Combobox` component:
```tsx
<Combobox
  value={selectedAgent}
  onChange={setSelectedAgent}
  items={[
    {
      category: "Agent",
      options: [
        { value: "build", label: "Build", description: "Execute tools and edit files" },
        { value: "plan", label: "Plan", description: "Read-only planning mode" },
      ],
    },
  ] as ComboboxGroup[]}
  direction="up"
  dropdownWidth="w-44"
  disabled={isProcessing}
  triggerClassName="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
>
  <span className="hidden sm:inline">{selectedAgent} agent</span>
</Combobox>
```

- [ ] **Step 5: Verify UI renders correctly**

Run: `npm run dev -w @open-inspect/web`
Open a session, verify the agent picker appears in the footer next to the model selector.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/app/(app)/session/[id]/page.tsx
git commit -m "feat: add agent picker (Build/Plan) to session footer"
```

---

### Task 7: Pass agent on session creation

**Files:**
- Modify: `packages/web/src/app/(app)/page.tsx:140-149`
- Modify: `packages/web/src/app/api/sessions/route.ts:57-69`

- [ ] **Step 1: Add agent state to home page**

In `page.tsx`, find where `selectedModel` state is managed and add:

```typescript
const [selectedAgent, setSelectedAgent] = useState<string>("build");
```

- [ ] **Step 2: Include `agent` in the session creation fetch body**

At lines 143-149, add `agent: selectedAgent`:

```typescript
body: JSON.stringify({
  repoOwner: owner,
  repoName: name,
  model: selectedModel,
  reasoningEffort,
  agent: selectedAgent,
  branch: selectedBranch || undefined,
}),
```

- [ ] **Step 3: Forward `agent` in the API route**

In `route.ts` at line 57-69, add to `sessionBody`:

```typescript
agent: body.agent,
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/(app)/page.tsx packages/web/src/app/api/sessions/route.ts
git commit -m "feat: pass agent selection through session creation flow"
```

---

## Chunk 5: Integration Verification

### Task 8: End-to-end verification

- [ ] **Step 1: Build all packages**

Run: `npm run build`
Expected: Clean build across all packages.

- [ ] **Step 2: Run all TypeScript tests**

```bash
npm test -w @open-inspect/control-plane
npm test -w @open-inspect/web
```

- [ ] **Step 3: Run Python tests**

```bash
cd packages/modal-infra && pytest tests/ -v
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 5: Run lint**

```bash
npm run lint:fix
```

- [ ] **Step 6: Final commit if any lint fixes**

```bash
git add -A && git commit -m "chore: lint fixes for agent selection feature"
```
