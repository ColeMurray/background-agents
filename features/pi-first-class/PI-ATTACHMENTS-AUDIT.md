# Pi attachments and images — audit, design, and implementation

Feature: **Pi attachments and images** (brief:
`features/pi-first-class/PI-REMAINING-AUDIT-BRIEFS.md`, section 2). Branch: `feat/pi-attachments`,
off `feat/pi-go-live-integration-v2`.

**Verdict: bucket B (adapter/plumbing).** No new table, no new scope, no new auth path. The Pi path
now reuses the existing attachment authority, the existing claim, the existing media bucket and the
existing binding-only Pi↔Session bridge. One new product fact was needed and it lives in `shared`
next to the other attachment bounds: the per-turn byte budget a Pi runtime can carry.

---

## 1. The audit

Everything below was read in the code. Where the repository's own documents claim something the code
does not support, the difference is called out in §5.

### 1.1 What the sandbox harness does with an attachment, step by step

| #   | Step                                                                                                                                                                                                             | Where                                                                                                                                                                                                                                           | Authority or transport   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | Client uploads the image as multipart `file`.                                                                                                                                                                    | `packages/control-plane/src/routes/session-attachments.ts:80` `handleAttachmentPost`                                                                                                                                                            | Open-Inspect (authority) |
| 2   | Request size cap (`SESSION_ATTACHMENT_MAX_REQUEST_BYTES` = 10 MB + 128 KB).                                                                                                                                      | `routes/session-attachments.ts:87-90`, `packages/control-plane/src/media.ts:19`                                                                                                                                                                 | Open-Inspect             |
| 3   | MIME allowlist (png/jpeg/webp/gif) and per-image cap (10 MB).                                                                                                                                                    | `routes/session-attachments.ts:116-122`, `packages/shared/src/types/session-attachments.ts:5-11`                                                                                                                                                | Open-Inspect             |
| 4   | Magic-byte detection, and a MIME-vs-content check.                                                                                                                                                               | `routes/session-attachments.ts:124-136`, `media.ts:132-151`                                                                                                                                                                                     | Open-Inspect             |
| 5   | Attachment id minted; object key `sessions/{publicSessionId}/attachments/{attachmentId}`.                                                                                                                        | `routes/session-attachments.ts:138-139`, `media.ts:153-155`                                                                                                                                                                                     | Open-Inspect             |
| 6   | **Registered** as a session resource: the SessionDO enforces the per-session quota (100 files / 500 MB), sweeps unreferenced rows older than 24 h, and writes the `attachments` row.                             | `packages/control-plane/src/session/services/session-attachment-storage.ts:44-50`, `packages/control-plane/src/session/http/handlers/attachments.handler.ts:55-98`, `packages/control-plane/src/session/session-attachment-repository.ts:25-35` | Open-Inspect (authority) |
| 7   | Bytes written to R2 (`MEDIA_BUCKET`).                                                                                                                                                                            | `session-attachment-storage.ts:49`, `routes/session-attachments.ts:140`                                                                                                                                                                         | Open-Inspect (authority) |
| 8   | The prompt references the upload as `{attachmentId, name}`; nothing else.                                                                                                                                        | `packages/shared/src/types/prompts.ts:44`, `packages/control-plane/src/session/session-attachment-resolver.ts:34-71`                                                                                                                            | Open-Inspect (authority) |
| 9   | The reference is resolved against **unclaimed** rows of this session only; a duplicate in one message is refused; the row is claimed for the message in the same transaction as the message.                     | `session-attachment-resolver.ts:40-52`, `packages/control-plane/src/session/message-repository.ts:512-520`, `session-attachment-repository.ts:57-70`                                                                                            | Open-Inspect (authority) |
| 10  | The message row keeps **metadata only** (`name`, `attachmentId`, `mimeType`).                                                                                                                                    | `packages/control-plane/src/session/message-queue.ts:1385`, `packages/shared/src/types/session-attachments.ts:36-41`                                                                                                                            | Open-Inspect (authority) |
| 11  | Dispatch to the sandbox carries **metadata only**, never bytes (the DO SQLite row caps at 2 MB).                                                                                                                 | `packages/control-plane/src/session/message-queue.ts:681-694`, and the route comment at `routes/session-attachments.ts:7-10`                                                                                                                    | Open-Inspect (authority) |
| 12  | The sandbox validates the untyped WebSocket boundary (≤ 6, id/name/mime shape) and **fetches the bytes itself** over the bounded media route with its sandbox token, bounded to 10 MB and 2 concurrent requests. | `packages/sandbox-runtime/src/sandbox_runtime/attachment_processor.py:46-82`, `:107-182`                                                                                                                                                        | Harness (transport)      |
| 13  | The harness hands the model an inline image: a `data:{mime};base64,{…}` file part in the OpenCode user message.                                                                                                  | `packages/sandbox-runtime/src/sandbox_runtime/attachment_processor.py:184-198`, `packages/sandbox-runtime/src/sandbox_runtime/harness/opencode_stream.py:852-856`                                                                               | Harness (transport)      |

So: Open-Inspect owns admission, quota, the one-time claim, the storage, and the bounded media
route. The harness owns the fetch, the base64 encoding, and the hand-off to the model SDK. The Pi
path must have exactly the same split.

### 1.2 The bounded media route the harness uses

`GET /sessions/:id/attachments/:attachmentId` — `routes/session-attachments.ts:251-255`, admitted
with `GITHUB_SANDBOX_FALLBACK_ROUTE` (sandbox token) and `requireSession("read")`; the handler
streams the object out of `MEDIA_BUCKET` and refuses anything whose stored content type is not an
allowed image (`routes/session-attachments.ts:182-238`).

The Pi Durable Object is not a sandbox and holds no sandbox token. It reaches the session the way
every other Pi capability does: over the `SESSION` Durable Object binding, on the `PiBridgeHandler`
— the class documented as "Internal, binding-only bridge from PiSessionDO to SessionDO-owned
capabilities" (`packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts:175-177`).

### 1.3 The Pi path today

- `packages/control-plane/src/session/message-queue.ts:1332-1334` (before this change) refused every
  attachment on a Pi session:
  `HarnessModelIncompatibleError("Pi Durable does not support attachments yet.")`.
- The Pi dispatch handed the runtime **text only**: `message-queue.ts:838-848` →
  `packages/control-plane/src/pi/runtime-contract.ts:8-16` (`PiRuntimePrompt` had no attachment
  field) → `packages/control-plane/src/cloudflare/pi-durable-object.ts:724-727`
  (`this.harness.submit(input.content, …)`).
- The web composer refused to send them: `packages/web/src/app/(app)/(sidebar)/page.tsx:230-231`,
  and disabled Send at `:265`.

### 1.4 Is there an existing path for a harness to hand a model an image it fetched itself?

**Yes, on both sides of the boundary, and the pieces already exist.**

- _The substrate accepts images._ `UserInput` is `UserMessage["content"]`, i.e.
  `string | (TextContent | ImageContent)[]`
  (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:357-361`, `260-264`;
  `node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:13`). A Pi submission is
  `{type: "input", content: UserInput}`
  (`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:23-36`), and the agents harness
  passes the input straight through (`node_modules/agents/dist/harness/pi/index.js:584-586`).
- _The wire format carries images._ The OpenAI Responses path turns an image block into
  `input_image` with a base64 data URL
  (`node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js:154-173`), and the Codex
  provider uses that path
  (`node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js:15`).
- _The model catalog knows which models take images._ `input: ["text","image"]` for every codex
  model except `gpt-5.3-codex-spark`
  (`node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json`).
- _The credential path is unchanged._ The model request is made by the Pi Durable Object with the
  brokered Codex token (`packages/control-plane/src/cloudflare/pi-durable-object.ts:1564-1618`,
  `packages/control-plane/src/pi/codex-credential-store.ts:31-124`); the image rides the same
  request, so no new credential path appears.

**The trap:** for a model that takes text only, pi-ai does not fail — it _silently replaces_ the
image with `(image omitted: model does not support images)`
(`node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js:38-57`). A Pi turn that silently
lost its image is the failure this feature must not have, so the turn is refused by name instead.

### 1.5 The existing bounds, and which of them are session bounds and which are message bounds

| Bound                 | Value                                | Where                                                                        | Scope       |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------------------- | ----------- |
| Request body          | 10 MB + 128 KB                       | `media.ts:19`                                                                | request     |
| Per image             | 10 MB                                | `packages/shared/src/types/session-attachments.ts:5`, `media.ts:8`           | image       |
| Per message           | 6 images                             | `packages/shared/src/types/session-attachments.ts:3`, `:30-32`               | **message** |
| Per session           | 100 files / 500 MB                   | `media.ts:20-21`, `attachments.handler.ts:75-86`                             | **session** |
| Unreferenced lifetime | 24 h, then pruned                    | `media.ts:24`, `attachments.handler.ts:55-73`                                | session     |
| Sandbox download      | 10 MB per image, 2 concurrent, 120 s | `packages/sandbox-runtime/src/sandbox_runtime/attachment_processor.py:87-89` | image       |

**The bound the Pi path inherits is therefore a message bound** (6 images) over a session-scoped
storage, and the _byte_ bound is the one thing the substrate forces to be smaller — see §2.3.

### 1.6 The boundary check

The authority spine is _Pi proposes → owning SessionDO authorizes → D1 resolves authority →
capability gateway executes → result returns through SessionDO audit/timeline/budget → Pi receives
only the bounded, credential-free result_. For attachments the spine is:

- **Pi proposes**: the Pi Durable Object asks the session for an image it was given.
- **SessionDO authorizes**: the session checks that the image is one _this turn_ claimed
  (`message_id = the turn`), and that the turn is an active Pi operation of this session.
- **D1 resolves authority**: the attachment row, its claim and its object key live in the session's
  own DO storage; nothing is read from D1 because the claim was made by the session itself at
  enqueue time.
- **Capability gateway executes**: the session reads the object out of its own media bucket.
- **Result returns**: the image bytes, and nothing else, back to the Pi Durable Object.
- **Pi receives a bounded, credential-free result**: raw bytes plus the row's MIME type. No object
  key, no session id, no credential, no provider string.

---

## 2. The design

### 2.1 The shape

```
client ──POST /sessions/:id/attachments──▶ session (media bucket + attachments row)   [unchanged]
client ──POST /sessions/:id/prompt {attachments:[{attachmentId,name}]}──▶ session       [unchanged]
        session resolves + claims the rows, stores metadata only on the message          [unchanged]
        session ──PiRuntimePrompt{attachments: metadata}──▶ Pi Durable Object            [new field]
        Pi Durable Object ──POST /internal/pi-attachment {attachmentId}──▶ session        [new route]
             session: active Pi operation? row claimed by this turn? → bytes from MEDIA_BUCKET
        Pi Durable Object hands the model [{type:"text"},{type:"image",data:base64}]
```

The Pi Durable Object is the _harness_ of a Pi turn, exactly as the sandbox is the harness of a
sandbox turn, and it fetches the image the way the sandbox does — through the session that owns it.
The bytes never ride the message queue, the prompt RPC, the event stream, or the timeline.

### 2.2 Reuse, item by item

| Piece                                         | Reused from                                                                        | Where                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Upload admission, quota, one-time claim       | `SessionAttachmentStorageService` + `AttachmentsHandler` + the `attachments` table | `session-attachment-storage.ts:44`, `attachments.handler.ts:55-98`, `session-attachment-repository.ts` |
| Storage                                       | `MEDIA_BUCKET` (R2) via the session's own `ObjectStorage` port                     | `packages/control-plane/src/types.ts:144`                                                              |
| Reference resolution and claim at enqueue     | `resolveSessionAttachments` + `createMessageWithAttachments`                       | `session-attachment-resolver.ts:34`, `message-repository.ts:512-520`                                   |
| Message-bound image count                     | `MAX_SESSION_ATTACHMENTS_PER_MESSAGE` (6)                                          | `packages/shared/src/types/session-attachments.ts:3`                                                   |
| MIME set                                      | `SESSION_ATTACHMENT_IMAGE_MIME_TYPES`                                              | `packages/shared/src/types/session-attachments.ts:6-11`                                                |
| Pi→Session call seam                          | `PiBridgeHandler` + `SessionInternalPaths` + the `SESSION` binding                 | `pi-bridge.handler.ts:175-177`, `session/contracts.ts:81-154`                                          |
| "This turn is a real Pi turn of this session" | `PiBridgeHandler.activeOperation`                                                  | `pi-bridge.handler.ts:698-706`                                                                         |
| Model capability question                     | the pi-ai model catalog, exactly as `hasTrustedPiPricing` uses the model registry  | `packages/control-plane/src/pi/pricing.ts:5-14`                                                        |

### 2.3 The one new fact: the per-turn byte budget

**Bucket A does not reach.** The Pi runtime keeps a turn's user message as **one** Durable Object
SQLite row:

- the input is appended as a `pi.user` entry whose `model` is the user message
  (`node_modules/@earendil-works/pi-durable/dist/harness/inbox.js:73-78`),
- the entry is written as one JSON record (`…/dist/session/transaction.js:150-173`),
- the record is one row of the `entries` table (`…/dist/storage/sqlite/migrations.js:25-33`),
- and a SQLite-backed Durable Object caps a row at **2 MB**
  (https://developers.cloudflare.com/durable-objects/platform/limits/ — "Maximum string, `BLOB` or
  table row size: 2 MB"). The repository already relies on this fact: "Durable Object SQLite rows
  cap at 2 MB — base64 payloads must never ride through the message queue"
  (`routes/session-attachments.ts:7-10`).

The images of one turn therefore travel base64-encoded **inside that single row**: 1 MiB of images
is ≈ 1.4 MB of base64, which still leaves room for the 64 000-character prompt
(`packages/shared/src/types/prompts.ts:4`) and the record's own fields. The budget is therefore
`PI_ATTACHMENT_MAX_TURN_BYTES = 1 MiB` per turn, and it is enforced **at enqueue**, by the session,
from the sizes the attachment rows already carry (`size_bytes`,
`packages/control-plane/src/session/types.ts:143-151`) — so the turn is refused before anything is
claimed, not after a runtime write fails opaquely.

The Pi Durable Object cannot carry a 10 MB image in one row under any encoding. The alternatives
were all rejected:

- **Downscale in the Pi Durable Object** (pi-durable ships a Photon image processor,
  `node_modules/@earendil-works/pi-durable/dist/images/index.d.ts`) — needs a new WASM module
  binding on the Pi DO class and a two-phase Terraform deploy, and the codex resize limit (4.7 MB)
  is still above the 2 MB row. Rejected: new binding, new infra, still insufficient.
- **Hand the model a URL and let the provider fetch it** — a new authority path (the provider
  becomes a reader of the session's media), and the ChatGPT backend does not fetch arbitrary URLs.
  Rejected: bucket C/D.
- **A model-visible tool that returns the image** — the tool result is persisted in Pi's transcript
  as well (one row per result, so the per-image budget would be ~1.4 MB), and it changes the
  semantics from "the image is in the prompt" to "the model has to ask for it". It also needs a Pi
  extension, a tool-effect registration and a policy delegate. Rejected here as bucket C; recorded
  in §4 as the escape hatch if the 1 MiB budget is judged too small.

### 2.4 The model-capability rule

Every codex model in the catalog except `gpt-5.3-codex-spark` takes images, and every model
Open-Inspect offers for Pi today is one of them. The check is still made, twice, and fails closed:

- **At enqueue** (session): `piModelAcceptsImages(model)` against the codex catalog
  (`packages/control-plane/src/pi/model-image-support.ts`) — a fast pre-check, refused with
  `HARNESS_MODEL_INCOMPATIBLE`.
- **At dispatch** (Pi Durable Object): the same question against **its own live model registry**
  (`this.models.getModel(...)`), which is the catalog the turn's model is really served from. This
  is the last authority, and it covers the case where the session's model changed between enqueue
  and dispatch. The Pi Durable Object refuses the turn with a bounded, public message instead of
  letting pi-ai silently drop the image.

### 2.5 What is new, exactly

| New                                               | Bucket                       | Why it is not a new primitive                                                                                                                                   |
| ------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionInternalPaths.piAttachment` + the handler | B                            | The same binding-only seam every Pi capability already uses (`piCredential`, `piContext`, `piCodeModeAuthorize`, …). It adds no table, no scope, no credential. |
| `SessionAttachmentRepository.getClaimedByMessage` | B                            | A read of the existing `attachments` table.                                                                                                                     |
| `PiRuntimePrompt.attachments`                     | B                            | Metadata only; the same shape the sandbox command already carries.                                                                                              |
| `PI_ATTACHMENT_MAX_TURN_BYTES`                    | B (a bound, not a primitive) | A number next to the other attachment bounds in `shared`; both the server and the composer use it.                                                              |
| `piModelAcceptsImages` / `modelAcceptsImages`     | B                            | A read of the pi-ai catalog, in the shape of the existing `hasTrustedPiPricing`.                                                                                |

---

## 3. What was implemented

- `packages/shared/src/types/session-attachments.ts` — `PI_ATTACHMENT_MAX_TURN_BYTES`.
- `packages/control-plane/src/session/session-attachment-resolver.ts` — the resolver now also
  reports the stored size of the resolved images, so the session can enforce the turn budget.
- `packages/control-plane/src/session/message-queue.ts` — the Pi refusal is gone; the session
  refuses a turn whose images do not fit the runtime (`SessionAttachmentError`, 400) or whose model
  takes text only (`HarnessModelIncompatibleError`, 400), and hands the Pi Durable Object the
  attachment metadata with the prompt.
- `packages/control-plane/src/pi/runtime-contract.ts` — `PiRuntimePrompt.attachments`.
- `packages/control-plane/src/pi/model-image-support.ts` — the model-capability question.
- `packages/control-plane/src/session/session-attachment-repository.ts` —
  `getClaimedByMessage(messageId, attachmentId)`.
- `packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts` — the `attachment` bridge:
  active Pi operation, attachment claimed by this turn, bytes from the session's own media bucket,
  MIME type from the row, nothing else in the answer.
- `packages/control-plane/src/session/contracts.ts`, `session/http/routes.ts`,
  `session/components.ts` — the route and its wiring.
- `packages/control-plane/src/cloudflare/pi-durable-object.ts` — the Pi Durable Object fetches the
  images from the session, base64-encodes them, and hands the model
  `[{type:"text"},{type:"image"}]`. A turn whose image cannot be loaded is refused **before** Pi
  admits it, so the model never runs a turn that quietly lost its image.
- `packages/web/src/app/(app)/(sidebar)/page.tsx` — the "Pi Durable does not support attachments
  yet" block is gone; the composer now refuses a Pi turn over the byte budget before uploading, and
  the first prompt for a Pi session with attachments creates the session and uploads to it.

### 3.1 Where the bytes live

| Store                                                                | Holds                                                                                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2 `MEDIA_BUCKET`, `sessions/{sessionId}/attachments/{attachmentId}` | the bytes (the authority's copy)                                                                                                                                        |
| The session's `attachments` row                                      | id, mime type, size, object key, the claiming message                                                                                                                   |
| The message row and the `user_message` event                         | **metadata only** (`name`, `attachmentId`, `mimeType`)                                                                                                                  |
| The Pi Durable Object's transcript (pi-durable's `entries` row)      | the turn's user message, with the image base64-encoded — the runtime's own conversation record, the same place the sandbox's OpenCode session file keeps its file parts |
| D1, the event stream, the timeline, the browser                      | never the bytes                                                                                                                                                         |

The bytes therefore never reach Open-Inspect's own stores (D1, the session's tables, the events, the
timeline). They do reach the _runtime's_ transcript, base64-encoded, exactly as the sandbox path
leaves them in the OpenCode session file. This is harness parity, not a Pi-only path — but it is the
one honest answer to "the bytes never cross into Pi's storage", and it is the reason the turn budget
exists at all.

---

## 4. Decisions that need a human

1. **The per-turn byte budget (1 MiB) is narrower than the sandbox path (10 MB per image).** It is
   forced by the Pi Durable substrate's 2 MB SQLite row, and it is enforced fail-closed at enqueue.
   If a larger image must work for Pi, the options are (a) downscale in the Pi Durable Object (new
   WASM binding + Terraform), (b) a model-visible tool that returns the image (bucket C: a new Pi
   extension, a tool-effect registration, a policy delegate, and the model has to ask for the
   image), or (c) a provider-side URL fetch (bucket C/D: the model provider becomes a reader of the
   session's media). All three are product decisions, not plumbing.
2. **The images live in the runtime's transcript.** The sandbox path leaves them in the OpenCode
   session file, so this is parity; if the product wants the bytes to leave the runtime as well,
   that is the tool-mediated design in (1b).
3. **A model that takes text only refuses the whole turn.** The alternative — sending the text and
   reporting that the image was dropped — is the silent-drop failure the audit in
   `features/pi-first-class/AUDIT-ROUND-6.md:159` says to avoid.

---

## 5. Where this reading differs from the repository's own documents

- `features/pi-first-class/STATE-AND-HANDOVER.md:282-288` says the seam is "the existing attachment
  authority and the bounded media routes" and that "the Pi turn needs the attachment's media
  reference to reach the model as an image block" with "the bound is the existing one". The **bound
  is not** the existing one: the existing bound is 10 MB per image, and the Pi Durable runtime
  cannot carry a 10 MB image in one Durable Object SQLite row (2 MB cap). The design inherits the
  _authority_, the MIME set and the per-message count, and narrows the per-turn byte budget with a
  documented, enforced reason.
- The same document's phrasing ("the attachment's media reference to reach the model") suggests a
  reference could travel to the model. It cannot: the OpenAI Responses path needs the image data
  inline (`input_image` with a base64 data URL), and pi-ai has no URL form for a user message image.
  The bytes must reach the model in the request.
- `features/pi-first-class/MULTIPLAYER-COMPATIBILITY-AUDIT.md:174` says Pi gets "scoped references
  only after support; no inline secret bytes or private bypass". The implementation keeps that shape
  on the Open-Inspect side (references only, no bytes in any Open-Inspect store, no bypass of the
  session) and, on the runtime side, hands the model the image inline — which is what the provider
  API requires and what the sandbox path already does.
- `features/pi-first-class/AUDIT-ROUND-6.md:159` ("Image attachments. Fail-closed with a clear
  error, not silently dropped.") is honoured twice: the session refuses a turn it cannot carry, and
  the Pi Durable Object refuses a turn whose model would drop the image.

---

## 6. UNVERIFIED / not checked here

- **Whether OpenCode persists the base64 data URL in its session file.** The sandbox path hands
  OpenCode a `data:` URL file part
  (`packages/sandbox-runtime/src/sandbox_runtime/attachment_processor.py:184-198`); what OpenCode
  does with it afterwards is outside this repository, so the "the sandbox keeps a copy too" claim
  rests on the shape of the request, not on OpenCode's storage code.
- **The 2 MB row cap in the running deployment.** The limit is Cloudflare's documented SQLite limit
  and the repository already cites it (`routes/session-attachments.ts:7-10`), but no test in this
  repository exercises a multi-megabyte row.
- **The `input` modality of a codex model at runtime.** The check reads the pi-ai catalog that ships
  with the pinned `@earendil-works/pi-ai@1.3.0`; a deployment that registered a different provider
  for Pi would need the live-registry check (the one in the Pi Durable Object) to be the deciding
  one.
- **Whether the web composer's new byte-budget message is the wording the product wants.**
- **The `MEDIA_BUCKET` read in the session runtime.** `Env.MEDIA_BUCKET` is the `ObjectStorage` port
  (`packages/control-plane/src/types.ts:144`) and the session already writes to the same bucket
  through it, but the _read_ path from inside the Durable Object (rather than from the router) was
  exercised only by the unit test, not against a live R2 in this change.

---

## 7. Tests

| Lane                                                                | Result                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build -w @open-inspect/shared`                             | pass                                                                                                                                                                                                                                                                                                                                     |
| `npm test -w @open-inspect/control-plane` (unit, node)              | 339 files, 5422 passed, 1 skipped                                                                                                                                                                                                                                                                                                        |
| `npm run test:integration -w @open-inspect/control-plane` (workerd) | `test/integration/pi-session-do.test.ts` 60 passed (2 new: the image reaches the model as an image block; a turn whose image the session cannot serve is refused before admission); `media.test.ts` + `session-attachments-auth.test.ts` 12 passed                                                                                       |
| `npm test -w @open-inspect/shared`                                  | 63 files, 1314 passed                                                                                                                                                                                                                                                                                                                    |
| `npm test -w @open-inspect/web`                                     | the sidebar composer test file passes on its own (31 passed). The full web lane is load-dependent in this environment: 21 failures here against 41–73 failures on the untouched base commit (`feat/pi-go-live-integration-v2`), in the same unrelated files (automations, settings, teams). No failure is in a file this change touches. |
| `npm run typecheck` (control-plane, web, shared)                    | pass                                                                                                                                                                                                                                                                                                                                     |
| `npm run lint` (control-plane, web, shared)                         | pass                                                                                                                                                                                                                                                                                                                                     |
| `prettier --check`                                                  | pass                                                                                                                                                                                                                                                                                                                                     |
