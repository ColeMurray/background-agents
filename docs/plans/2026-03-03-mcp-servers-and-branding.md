# Plan: File/Image Support, Agent Self-Verification, Progress Updates + Branding

**Status:** Implemented (tests deferred: Tasks 8, 14, 18, 27)

## Context

Three related gaps in the system:

1. **Files & images** — The system is text-only. No entry point (Slack, Web, GitHub, Linear) sends
   files or images to the agent, despite the control plane having partial plumbing (`Attachment`
   type, `attachments` column in message queue).

2. **Agent self-verification** — The sandbox has Playwright + Chromium installed, but there's no
   tool for the agent to launch a browser, take screenshots, or visually verify its work. The agent
   should be able to run the app it's building and confirm it looks right.

3. **Progress screenshots** — The agent can't send intermediate updates back to the invoking client.
   When it takes a screenshot or hits a milestone, it should be able to push that to
   Slack/Web/Linear in real time — not just at completion.

### What already exists

- `ArtifactType = "pr" | "screenshot" | "preview" | "branch"` — screenshot is a first-class artifact
- `artifact` event type flows: bridge → control plane → web UI (via WebSocket) + Slack/Linear (via
  callbacks)
- Playwright + Chromium installed in sandbox base image
- Slack callback extracts artifacts and renders in completion blocks (but only as text links)
- Linear callback emits intermediate `AgentActivity` events for tool calls
- OpenCode accepts `FilePartInput: { type: "file", mime: string, url: string }` in prompt parts

## Approach

All files and images flow through **Cloudflare R2** — no base64 inline payloads through WebSockets.
R2 is already used for Terraform state; we add a new `axiom-media` bucket with signed URLs for
upload/download. The control plane worker gets an R2 bucket binding and exposes presigned URL
endpoints. The sandbox bridge uploads screenshots to R2 via the control plane, and Slack/Web/Linear
all reference R2 URLs directly.

Work in five phases, each independently shippable:

**Phase 0** — R2 infrastructure: Terraform bucket + worker binding + presigned URL endpoints **Phase
1** — Bridge: pass inbound attachments through to OpenCode (unblocks file/image input) **Phase 2** —
Slack bot: extract files from events, upload to R2, send R2 URLs as attachments **Phase 3** — Agent
tools: browser verification + screenshot + send-update plugins (upload to R2) **Phase 4** —
Outbound: render R2-hosted screenshots in Slack/Web/Linear, intermediate progress updates

## Changes

### 0. R2 infrastructure — media bucket + worker binding + upload/download API

**Files:**

- `terraform/modules/cloudflare-r2/main.tf` — new module (mirrors `cloudflare-kv/`)
- `terraform/modules/cloudflare-r2/variables.tf`
- `terraform/modules/cloudflare-r2/outputs.tf`
- `terraform/modules/cloudflare-worker/main.tf` — add R2 binding type to `locals.bindings`
- `terraform/modules/cloudflare-worker/variables.tf` — add `r2_bindings` variable
- `terraform/environments/production/r2.tf` — instantiate `axiom-media` bucket
- `terraform/environments/production/workers-control-plane.tf` — pass R2 binding
- `packages/control-plane/src/media/r2-media-service.ts` — upload + signed URL generation
- `packages/control-plane/src/api/media-routes.ts` — REST endpoints for upload + download

**Terraform — R2 bucket module:**

```hcl
# terraform/modules/cloudflare-r2/main.tf
resource "cloudflare_r2_bucket" "this" {
  account_id = var.account_id
  name       = var.bucket_name
}
```

```hcl
# terraform/environments/production/r2.tf
module "media_bucket" {
  source      = "../../modules/cloudflare-r2"
  account_id  = var.cloudflare_account_id
  bucket_name = "${var.deployment_name}-media"
}
```

**Worker binding — add R2 to cloudflare-worker module:**

```hcl
# In cloudflare-worker/main.tf — add to locals.bindings
r2_bindings = [for b in var.r2_bindings : {
  type       = "r2_bucket"
  name       = b.binding_name
  bucket_name = b.bucket_name
}]
```

```hcl
# In workers-control-plane.tf — pass binding
r2_bindings = [{
  binding_name = "MEDIA_BUCKET"
  bucket_name  = module.media_bucket.bucket_name
}]
```

**Control plane — R2 media service:**

```typescript
// packages/control-plane/src/media/r2-media-service.ts
export class R2MediaService {
  constructor(private bucket: R2Bucket) {}

  /** Upload binary content, return the object key. */
  async upload(
    key: string,
    body: ArrayBuffer | ReadableStream,
    contentType: string
  ): Promise<string> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType },
    });
    return key;
  }

  /** Generate a time-limited signed URL for reading. */
  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    // R2 presigned URLs require the S3-compatible API
    // Alternative: serve through a worker route
    const object = await this.bucket.head(key);
    if (!object) throw new Error(`Object not found: ${key}`);
    // For v1: serve through control plane worker route
    return `/api/media/${encodeURIComponent(key)}`;
  }

  /** Stream object content for the proxy route. */
  async get(key: string): Promise<{ body: ReadableStream; contentType: string } | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
    };
  }
}
```

**Control plane — media routes (proxy for signed access):**

```typescript
// packages/control-plane/src/api/media-routes.ts
// GET /api/media/:key — proxy R2 object with cache headers
// POST /api/media/upload — accept multipart upload, store in R2, return key + URL
// Used by: Slack bot (inbound files), bridge (outbound screenshots)
```

The control plane worker acts as a proxy for R2 reads — this avoids needing custom domain setup for
R2 public access in v1. Objects are keyed as `{sessionId}/{uuid}.{ext}`.

### 1. Bridge — pass inbound attachments to OpenCode

**Files:** `packages/modal-infra/src/sandbox/bridge.py`

`_handle_prompt()` currently ignores `attachments` from the `PromptCommand`. Fix: extract them,
convert to OpenCode's `FilePartInput` format, add to the `parts` array. Attachments now carry R2
URLs (uploaded by Slack bot or web client before reaching the bridge).

```python
# In _handle_prompt() — extract attachments
attachments = cmd.get("attachments")

# In _build_prompt_request_body() — convert to OpenCode parts
def _build_prompt_request_body(
    self,
    content: str,
    model: str | None,
    opencode_message_id: str | None = None,
    reasoning_effort: str | None = None,
    attachments: list[dict] | None = None,
) -> dict[str, Any]:
    parts: list[dict[str, Any]] = [{"type": "text", "text": content}]

    if attachments:
        for att in attachments:
            mime = att.get("mimeType", "application/octet-stream")
            name = att.get("name", "attachment")
            url = att.get("url", "")  # R2 URL set by Slack bot / web client
            if url:
                parts.append({"type": "file", "mime": mime, "url": url, "filename": name})

    request_body: dict[str, Any] = {"parts": parts}
    # ... existing model/reasoning config ...
    return request_body
```

### 2. Slack bot — extract files, upload to R2, send R2 URLs as attachments

**Files:** `packages/slack-bot/src/index.ts`

Add `files` to the event type. Download files using the bot token, upload to R2 via the control
plane media endpoint, pass R2 URLs as attachments (no base64 through WebSockets):

```typescript
// Slack event type addition
files?: Array<{
  id: string;
  name: string;
  mimetype: string;
  url_private_download: string;
  size: number;
}>;

// In handleAppMention() — download files and upload to R2
const attachments: Attachment[] = [];
if (event.files?.length) {
  for (const file of event.files.slice(0, 5)) {  // Max 5 files
    if (file.size > 10 * 1024 * 1024) continue;   // 10MB limit
    const resp = await fetch(file.url_private_download, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    if (!resp.ok) continue;
    const buf = await resp.arrayBuffer();

    // Upload to R2 via control plane media endpoint
    const uploadResp = await fetch(`${env.CONTROL_PLANE_URL}/api/media/upload`, {
      method: "POST",
      headers: { "Content-Type": file.mimetype, "X-Filename": file.name },
      body: buf,
    });
    if (!uploadResp.ok) continue;
    const { url } = await uploadResp.json<{ url: string }>();

    attachments.push({
      type: file.mimetype.startsWith("image/") ? "image" : "file",
      name: file.name,
      mimeType: file.mimetype,
      url,  // R2 URL — no base64
    });
  }
}

// Pass in sendPrompt call
body: JSON.stringify({ content, authorId, source: "slack", callbackContext, attachments })
```

### 3. Web UI — file upload in prompt input

**Files:**

- `packages/web/src/components/file-upload-zone.tsx` — drag-drop + paste wrapper
- `packages/web/src/app/(app)/page.tsx` — home prompt input
- `packages/web/src/app/(app)/session/[id]/page.tsx` — session prompt input

Wrap textarea with a drop zone. Handle drag-drop, clipboard paste (screenshots), and a file picker
button. Show thumbnails below textarea. Send attachments via WebSocket/POST.

### 4. Agent browser — install `agent-browser` in sandbox image

**Files:** `packages/modal-infra/src/images/base.py`

Use Vercel's [agent-browser](https://github.com/vercel-labs/agent-browser) — a CLI tool built
specifically for AI agents. It provides:

- **Accessibility tree snapshots** with element refs (AI-friendly, not CSS selectors)
- **Screenshot + screenshot diffing** (built-in pixel-level comparison)
- **Semantic selectors** — find elements by ARIA roles, labels, placeholders
- **Session state persistence** across CLI invocations
- **Network interception**, console tracking, DevTools profiling

The agent invokes it via its existing `Bash` tool — no custom OpenCode plugin needed.

**Installation in base image:**

```python
# In base.py — add to the image build
.run_commands(
    "npm install -g agent-browser",
)
```

Playwright + Chromium are already installed in the image, and `agent-browser` uses them under the
hood.

**Agent usage pattern** (via Bash tool):

```bash
# Start dev server in background
npm run dev &

# Navigate and take a snapshot (accessibility tree)
agent-browser navigate http://localhost:3000
agent-browser snapshot              # Returns accessibility tree with [ref] IDs

# Take a screenshot
agent-browser screenshot --path /tmp/screenshot.png

# Interact using semantic selectors
agent-browser click --role button --name "Submit"
agent-browser fill --role textbox --name "Email" --value "test@example.com"

# Compare screenshots (visual regression)
agent-browser screenshot --path /tmp/after.png
agent-browser screenshot-diff /tmp/screenshot.png /tmp/after.png

# Check console for errors
agent-browser console
```

No custom plugin code. The agent already has Bash — `agent-browser` is just another CLI tool.

### 5. Agent tools — `upload-media.js` + `send-update.js` OpenCode plugins

**Files:**

- `packages/modal-infra/src/sandbox/tools/upload-media.js` — upload any file to R2, returns URL
- `packages/modal-infra/src/sandbox/tools/send-update.js` — push progress updates to the user

Two tools: `upload-media` handles R2 uploads (general-purpose), `send-update` sends progress updates
and optionally uploads a screenshot to R2 before sending.

#### `upload-media.js` — general-purpose R2 upload tool

```javascript
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch } from "./_bridge-client.js";
import { readFileSync } from "fs";
import { basename, extname } from "path";

export default tool({
  name: "upload-media",
  description:
    "Upload a file to cloud storage and get back a public URL. Use this to share images, " +
    "screenshots, logs, or any file with the user. The URL can be included in messages, " +
    "comments, or PR descriptions. Commonly used after agent-browser screenshots.",
  args: {
    filePath: z.string().describe("Absolute path to the file to upload"),
    mimeType: z.string().optional().describe("MIME type (auto-detected from extension if omitted)"),
  },
  async execute(args) {
    const ext = extname(args.filePath).toLowerCase();
    const mime =
      args.mimeType ??
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".log": "text/plain",
        ".json": "application/json",
        ".html": "text/html",
      }[ext] ??
      "application/octet-stream";

    let buffer;
    try {
      buffer = readFileSync(args.filePath);
    } catch (e) {
      return `Failed to read file at ${args.filePath}: ${e.message}`;
    }

    // Upload to R2 via bridge → control plane
    const response = await bridgeFetch("/media/upload", {
      method: "POST",
      headers: {
        "Content-Type": mime,
        "X-Filename": basename(args.filePath),
      },
      body: buffer,
    });

    if (!response.ok) {
      return `Upload failed: ${response.status}`;
    }
    const { url } = await response.json();
    return `Uploaded: ${url}`;
  },
});
```

#### `send-update.js` — progress updates with optional screenshot

```javascript
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch } from "./_bridge-client.js";
import { readFileSync } from "fs";

export default tool({
  name: "send-update",
  description:
    "Send a progress update to the user. The message appears in real-time wherever the " +
    "session was started (Slack thread, web UI, or Linear issue). Use this to report " +
    "milestones, share screenshots, or ask for input during long tasks. If a screenshot " +
    "path is provided, the image is uploaded to cloud storage and included in the update.",
  args: {
    message: z.string().describe("Update message (markdown supported)"),
    screenshotPath: z
      .string()
      .optional()
      .describe(
        "Path to a screenshot file (e.g., from agent-browser screenshot --path /tmp/screenshot.png)"
      ),
  },
  async execute(args) {
    let screenshotUrl = null;

    // Upload screenshot to R2 if provided
    if (args.screenshotPath) {
      let buffer;
      try {
        buffer = readFileSync(args.screenshotPath);
      } catch (e) {
        return `Failed to read screenshot at ${args.screenshotPath}: ${e.message}`;
      }

      const uploadResp = await bridgeFetch("/media/upload", {
        method: "POST",
        headers: { "Content-Type": "image/png", "X-Filename": "screenshot.png" },
        body: buffer,
      });
      if (!uploadResp.ok) {
        return `Screenshot upload failed: ${uploadResp.status}`;
      }
      const { url } = await uploadResp.json();
      screenshotUrl = url;
    }

    // Send update event through bridge → control plane → clients
    const response = await bridgeFetch("/updates", {
      method: "POST",
      body: JSON.stringify({
        message: args.message,
        screenshotUrl, // R2 URL, not base64
      }),
    });

    if (!response.ok) {
      return `Failed to send update: ${response.status}`;
    }
    return screenshotUrl
      ? `Update sent with screenshot: ${screenshotUrl}`
      : "Update sent to the user.";
  },
});
```

**Agent workflow:**

```
1. agent-browser screenshot --path /tmp/before.png
2. [agent makes code changes]
3. agent-browser screenshot --path /tmp/after.png
4. agent-browser screenshot-diff /tmp/before.png /tmp/after.png
5. send-update "Here's what I changed:" --screenshotPath /tmp/after.png
   → uploads to R2, sends update with R2 URL
6. upload-media /tmp/before.png
   → returns R2 URL for use in PR descriptions, etc.
```

### 6. Bridge — media upload proxy + update forwarding endpoints

**Files:** `packages/modal-infra/src/sandbox/bridge.py`

Add local HTTP endpoints that the agent tools call. The bridge proxies media uploads to the control
plane (which writes to R2) and forwards update events through the WebSocket connection.

```python
# New bridge HTTP routes (alongside existing /health, /children, etc.)

@app.post("/media/upload")
async def handle_media_upload(request):
    """Proxy file upload to control plane → R2. Returns { url }."""
    content_type = request.headers.get("content-type", "application/octet-stream")
    filename = request.headers.get("x-filename", "upload")
    body = await request.body()

    # Forward to control plane media endpoint
    resp = await self._control_plane_fetch("/api/media/upload", {
        "method": "POST",
        "headers": {
            "Content-Type": content_type,
            "X-Filename": filename,
            "X-Session-Id": self._session_id,
        },
        "body": body,
    })
    if not resp.ok:
        return JSONResponse({"error": "Upload failed"}, status_code=resp.status)

    data = resp.json()
    return JSONResponse({"url": data["url"]})

@app.post("/updates")
async def handle_update(request):
    """Agent sends a progress update to the user."""
    data = await request.json()
    message = data.get("message", "")
    screenshot_url = data.get("screenshotUrl")  # Already an R2 URL

    # Emit as event through WebSocket — lightweight, no base64 payload
    await self._send_event({
        "type": "agent_update",
        "message": message,
        "screenshotUrl": screenshot_url,  # R2 URL reference
    })
    return JSONResponse({"ok": True})
```

The bridge also needs a `_control_plane_fetch` helper to make authenticated HTTP requests to the
control plane API (similar to how it already connects via WebSocket). This reuses the same auth
credentials.

### 7. Control plane — handle new event types

**Files:**

- `packages/shared/src/types/index.ts` — add `"agent_update"` to `EventType`
- `packages/control-plane/src/session/durable-object.ts` — store and broadcast
- `packages/control-plane/src/session/callback-notification-service.ts` — forward updates to bots

Add `agent_update` as a new event type. On receipt:

1. Store in events table (like other events)
2. Broadcast to WebSocket clients (web UI gets it immediately)
3. Forward to Slack/Linear via callback if session has callback context

```typescript
// In callback-notification-service.ts — new callback type
case "agent_update": {
  // Forward to bot that originated the session
  await this.sendCallback(message.source, "/callbacks/update", {
    sessionId,
    messageId,
    message: event.data.message,
    screenshotUrl: event.data.screenshotUrl,  // R2 URL (lightweight)
    timestamp: Date.now(),
    context: callbackContext,
    signature,
  });
  break;
}
```

### 8. Slack bot — render screenshots and updates

**Files:**

- `packages/slack-bot/src/callbacks.ts` — add `/callbacks/update` handler
- `packages/slack-bot/src/completion/blocks.ts` — render screenshots in completion
- `packages/slack-bot/src/utils/slack-client.ts` — add `uploadFile()` function

**Intermediate updates** — new callback route:

```typescript
callbacksRouter.post("/update", async (c) => {
  const payload = await c.req.json();
  // Verify signature...

  const { context, message, screenshotUrl } = payload;

  if (screenshotUrl) {
    // Post message with image block referencing the R2 URL
    await postMessage(c.env.SLACK_BOT_TOKEN, context.channel, message, {
      thread_ts: context.threadTs,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: message || "Agent screenshot" } },
        { type: "image", image_url: screenshotUrl, alt_text: "Screenshot" },
      ],
    });
  } else {
    // Text-only update
    await postMessage(c.env.SLACK_BOT_TOKEN, context.channel, message, {
      thread_ts: context.threadTs,
    });
  }

  return c.json({ ok: true });
});
```

Note: Slack's `image` block requires a publicly-accessible URL. The R2 media proxy route on the
control plane serves this — objects are accessed via `{CONTROL_PLANE_URL}/api/media/{key}`.

**Completion screenshots** — in `buildCompletionBlocks()`, render screenshot artifacts:

```typescript
// In artifact rendering section — handle screenshot type
const screenshots = response.artifacts.filter((a) => a.type === "screenshot");
if (screenshots.length > 0) {
  // Screenshots were uploaded to Slack during execution via /callbacks/update
  // Reference them in completion by noting they exist
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `📸 ${screenshots.length} screenshot(s) shared above` }],
  });
}
```

### 9. Web UI — render screenshots and updates

**Files:**

- `packages/web/src/hooks/use-session-socket.ts` — handle `agent_update` events
- `packages/web/src/app/(app)/session/[id]/page.tsx` — render inline
- `packages/web/src/components/session-right-sidebar.tsx` — screenshots in artifact panel

`agent_update` events render inline in the session timeline:

```tsx
case "agent_update": {
  const { message, screenshotUrl } = event.data;
  return (
    <div className="border-l-2 border-accent pl-3 my-2">
      <p className="text-sm text-foreground">{message}</p>
      {screenshotUrl && (
        <img
          src={screenshotUrl}  // R2 URL — no base64 bloat
          alt="Agent screenshot"
          className="mt-2 max-w-lg border border-border cursor-pointer"
          onClick={() => openFullscreen(screenshotUrl)}
        />
      )}
    </div>
  );
}
```

### 10. Linear bot — render updates

**Files:** `packages/linear-bot/src/callbacks.ts`

Forward `agent_update` as a Linear activity with image in markdown:

```typescript
// In callbacks router — handle update
callbacksRouter.post("/update", async (c) => {
  const payload = await c.req.json();
  // Verify signature...

  const { context, message, screenshotUrl } = payload;

  // Linear activities support markdown — embed R2 image URL directly
  const body = screenshotUrl ? `${message}\n\n![Screenshot](${screenshotUrl})` : message;

  await emitActivity(c.env, context, { type: "progress", message: body });

  return c.json({ ok: true });
});
```

R2 URLs are publicly accessible through the control plane proxy, so Linear can render them inline.

### 11. README — Axiom ASCII logo

**Files:** `README.md`, `docs/axiom-logo.svg`

Create SVG with blue ASCII art, embed in README header:

```markdown
<p align="center">
  <img src="docs/axiom-logo.svg" alt="Axiom" width="500" />
</p>
<p align="center">
  Background coding agent for Axios HQ.
</p>
```

## Edge Cases

- **R2 object lifecycle**: Objects accumulate over time. Add a lifecycle rule to the R2 bucket to
  auto-delete objects after 30 days. Session artifacts in D1 keep the metadata but the media
  expires.
- **R2 proxy auth**: The control plane media proxy route (`/api/media/:key`) serves R2 objects. For
  v1 this is unauthenticated (public read). Consider adding session-scoped access tokens or
  short-lived signed URLs in a follow-up if access control is needed.
- **Large file uploads**: The Slack bot limits to 10MB per file, 5 files per message. The agent's
  `upload-media` tool has no hard limit but R2 single-part uploads max at 5GB. Screenshots are
  typically 100KB-2MB.
- **agent-browser session state**: `agent-browser` persists state across CLI calls within a session.
  If the sandbox restarts (crash recovery), browser state is lost — agent needs to re-navigate.
- **Dev server startup**: The agent needs to start a dev server before navigating. It already has
  the `Bash` tool for `npm run dev`. Then `agent-browser navigate http://localhost:3000`.
- **agent-browser image size**: `agent-browser` is a Rust binary + Node fallback. Adds ~50MB to the
  sandbox image. Playwright + Chromium are already installed so no additional browser overhead.
- **Update flooding**: Rate-limit agent updates — max 1 per 10 seconds per session to prevent spam.
  The callback notification service already throttles tool call callbacks (1 per 3s).
- **Slack image block requirements**: Slack's `image` block requires a publicly-accessible HTTPS
  URL. The R2 proxy on the control plane serves this. If the control plane is behind auth, the Slack
  bot may need to download from R2 and re-upload via `files.upload` as a fallback.
- **WebSocket event size**: With R2 URLs instead of base64, `agent_update` events are ~200 bytes
  (just a URL + message) instead of ~1MB (base64 screenshot). This keeps WebSocket traffic light.

## Testing

- **Bridge**: Build request body with attachments → verify OpenCode `parts` format
- **Slack bot**: Mock event with `files` → verify download + base64 encoding
- **Browser tool**: Integration test in sandbox — navigate to example.com, take screenshot, verify
  PNG
- **Send-update tool**: Mock bridge endpoint, verify event emission
- **Callback update**: Slack callback receives update → uploads file to Slack
- **Web UI**: Agent update events render inline with screenshot preview

## Tasks

### Phase 0: R2 infrastructure (everything else depends on this)

- [x] Task 1: Create `terraform/modules/cloudflare-r2/` module (main.tf, variables.tf, outputs.tf)
- [x] Task 2: Instantiate `axiom-media` bucket in `terraform/environments/production/r2.tf`
- [x] Task 3: Add R2 binding support to `terraform/modules/cloudflare-worker/main.tf` + variables
- [x] Task 4: Pass `MEDIA_BUCKET` R2 binding to control-plane worker in `workers-control-plane.tf`
- [x] Task 5: Create `R2MediaService` in `packages/control-plane/src/media/r2-media-service.ts`
- [x] Task 6: Create media routes (`POST /api/media/upload`, `GET /api/media/:key`) in control plane
- [x] Task 7: Add R2 bucket lifecycle rule (auto-delete after 30 days) — noted in module; requires
      dashboard config
- [ ] Task 8: Tests for R2 media service + upload/download routes

### Phase 1: Inbound files — bridge + Slack (unblocks image input)

- [x] Task 9: Bridge `_build_prompt_request_body()` — accept attachments with R2 URLs, convert to
      FilePartInput
- [x] Task 10: Bridge `_handle_prompt()` — extract attachments from command
- [x] Task 11: Slack bot — add `files` to event type, download files, upload to R2, get URLs
- [x] Task 12: Slack bot — pass attachments (with R2 URLs) in `sendPrompt()` call
- [x] Task 13: Web WebSocket hook — forward attachments in prompt send
- [ ] Task 14: Tests for bridge multimodal and Slack file→R2 handling

### Phase 2: Web UI file upload

- [x] Task 15: Create `FileUploadZone` component (drag-drop + paste)
- [x] Task 16: Add attachment preview (thumbnails + chips) to prompt area
- [x] Task 17: Upload files to R2 via media endpoint, wire R2 URLs into WebSocket send + POST send
- [ ] Task 18: Web component tests

### Phase 3: Agent verification + progress tools

- [x] Task 19: Install `agent-browser` in sandbox base image + bump `CACHE_BUSTER`
- [x] Task 20: Create `upload-media.js` OpenCode plugin (reads file from disk, uploads to R2 via
      bridge)
- [x] Task 21: Create `send-update.js` OpenCode plugin (uploads screenshot to R2, sends update
      event)
- [x] Task 22: Bridge — add `/media/upload` proxy endpoint + `_control_plane_fetch` helper
- [x] Task 23: Bridge — add `/updates` endpoint (emits `agent_update` with R2 URL)
- [x] Task 24: Add `agent_update` to `EventType` in shared types
- [x] Task 25: Control plane — store + broadcast `agent_update` events
- [x] Task 26: Control plane — forward updates via callback notification service
- [ ] Task 27: Tests for upload-media tool, send-update tool, bridge endpoints

### Phase 4: Outbound rendering

- [x] Task 28: Slack bot — add `/callbacks/update` handler with R2 image URLs in blocks
- [x] Task 29: Slack bot — render screenshots in completion blocks (R2 URLs)
- [x] Task 30: Web UI — render `agent_update` events inline in session timeline (R2 image URLs)
- [x] Task 31: Web UI — screenshot in artifact sidebar (covered by inline rendering in Task 30)
- [x] Task 32: Linear bot — forward updates as activities with R2 image markdown
- [x] Task 33: Rate-limit agent updates (max 1 per 10s per session) — throttle in callback service

### Phase 5: Branding

- [x] Task 34: Create `docs/axiom-logo.svg` with blue ASCII art
- [x] Task 35: Update README.md header

## Open Questions

1. ~~**Image hosting for screenshots**~~ — **Resolved: R2 from the start.** All media goes through
   the `axiom-media` R2 bucket. No base64 in WebSocket events.
2. **OpenCode `FilePartInput.url` format**: Does it accept R2 proxy URLs
   (`https://control-plane.../api/media/key`)? If OpenCode requires the file to be locally
   accessible, the bridge may need to download from R2 to `/tmp/` and pass `file:///` paths instead.
   Needs quick manual test.
3. **agent-browser version pinning**: Pin to a specific version in the image build, or use
   `@latest`? Recommend pinning for reproducibility, update manually.
4. **`agent_update` vs existing `artifact` event**: Should progress updates use the existing
   `artifact` event type, or a new `agent_update` type? Using `artifact` is simpler but conflates
   "agent produced something" with "agent wants to communicate." Recommend separate type for
   clarity.
5. **GitHub bot**: Should the GitHub bot also handle screenshots? PR comments support inline images
   via markdown. Lower priority but straightforward once R2 infrastructure exists.
6. **R2 public access**: The control plane media proxy serves R2 objects unauthenticated for v1.
   Should we add access control (session-scoped tokens, time-limited signed URLs) before shipping?
