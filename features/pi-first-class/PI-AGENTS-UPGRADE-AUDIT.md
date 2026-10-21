# The `agents` 0.29.0 upgrade: audit, evidence, and outcome

**Change:** bump the exact `agents` pin from `0.28.1` to `0.29.0` in the Open-Inspect Pi
integration, and delete the compatibility shim the bump makes unnecessary.

**Branch:** `feat/pi-agents-upgrade`, rebased onto `feat/pi-go-live-integration-v2` at `b23780cd`.

**Commits** (the branch tip is the last of these; they are named by subject because the base branch
was moving underneath the work and rebasing rewrites their hashes):

1. `feat: upgrade the agents SDK to 0.29.0 and drop its shim`
2. `test: pin the Agents SDK's pi skills contract against the installed SDK`
3. `docs: record the upgrade's control run and the pi lane results`
4. `docs: the upgrade, rebased and re-verified on the current base`

**Brief:** `features/pi-first-class/PI-REMAINING-AUDIT-BRIEFS.md`, section 7.

**Outcome:** the upgrade is **safe and taken**. The shim and its rename guard are gone, the worker
bundle's resolution changes by exactly four files (one renamed chunk, one storage adapter swapped
for the identical one in Pi Durable), and the MCP broker's resolution is byte-identical before and
after.

One of the brief's three findings did not survive the audit, and it is the one that would have
caused real damage. Section 5 records it.

---

## 1. Method

Two tarballs were fetched and unpacked side by side, and every surface Open-Inspect imports was
diffed file by file:

```
npm pack agents@0.28.1 agents@0.29.0
```

The comparison is over the **published tarballs**, not over release notes, and the code claims are
checked against the **installed tree** in `node_modules` after the bump.

The worker bundle's resolution was captured before and after the change from esbuild's
`dist/meta.json` (`packages/control-plane/dist/meta.json`), and the two input lists were diffed.
That is the ground truth for "what the shipped worker resolves".

**The base branch moved while the audit was running, twice.** `feat/pi-go-live-integration-v2`
advanced from `a6ab76de` to `95ea8054` (the Pi integration audit and three fixes it drove) and then
to `b23780cd` (two commits removing a temporary patch script). The branch was rebased onto each new
tip — the merges are clean, the base still pins `agents@0.28.1`, and the base's
`packages/shared/src/pi-tool-effects.ts` still declares `activate_skill` and `read_skill_resource`
at the same lines — and every lane was re-run on the rebased tree. The results in section 8 are the
ones from the final rebase, onto `b23780cd`.

## 2. The dependency surface of `agents` inside this repo

`agents` is a dependency of **exactly one package**: `@open-inspect/control-plane`
(`packages/control-plane/package.json:33`). No other package — web, shared, slack-bot, github-bot,
linear-bot, pi-codemode-sandbox, modal-infra — imports it, directly or transitively.
`packages/web/package.json` has no `agents` entry and no path to one, which is why the web lane is
not in the blast radius (section 8).

Five entry points are imported, across seven files:

| Entry point                           | Symbol(s) used                                                      | Site                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents/harness/pi`                   | `PiHarness`                                                         | `packages/control-plane/src/cloudflare/pi-durable-object.ts:35`                                                                             |
| `agents/harness/pi`                   | `skills` (dynamic `import()`)                                       | `packages/control-plane/src/pi/managed-skills-extension.ts:17`                                                                              |
| `agents/lifecycle`                    | `Lifecycle`                                                         | `packages/control-plane/src/cloudflare/pi-durable-object.ts:36`; `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts:3` |
| `agents/lifecycle`                    | `LifecycleCapability`, `LifecycleJobContext`, `LifecycleJobOutcome` | `packages/control-plane/src/pi/repository-diff-publication.ts:1-5`; `packages/control-plane/src/pi/projection-capability.ts:1-5`            |
| `agents/skills`                       | `SkillContent`, `SkillResource`, `SkillSource` (**types only**)     | `packages/control-plane/src/pi/skill-source.ts:2`; `packages/control-plane/src/pi/managed-skills-extension.ts:7`                            |
| `agents/mcp/client`                   | `MCPClientManager`                                                  | `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts:2`                                                                  |
| `agents/mcp/do-oauth-client-provider` | `DurableObjectOAuthClientProvider`                                  | `packages/control-plane/src/mcp/encrypted-oauth-provider.ts:1`                                                                              |

Two consequences worth stating plainly:

- **`agents/browser` is never imported.** Open-Inspect's browser capability is
  `@cloudflare/computer`'s `Workspace` plus its own transport
  (`packages/control-plane/src/pi/browser-transport.ts`,
  `packages/control-plane/src/cloudflare/browser-rendering-transport.ts`). The `agents` browser
  changed between 0.28.1 and 0.29.0 (`dist/browser-*.js` differ), and **none of it reaches
  Open-Inspect**: the bundle's `agents` inputs are listed in section 7 and contain no browser
  module.
- **`agents/skills` is imported for types only.** The runtime `agents/dist/skills/index.js` — the
  part that changed most between the two versions — is **not in the worker bundle** (section 7). It
  is erased at build time.

The two tool names the skills extension publishes, `activate_skill` and `read_skill_resource`, are
also Open-Inspect's own registry entries in `packages/shared/src/pi-tool-effects.ts:63,65`. The
upgrade does not change them (section 4).

## 3. The verified tarball comparison

`diff -rq` over the two `dist` trees, then per-region diffs of the modules Open-Inspect imports.

| Surface                                               | 0.28.1                                          | 0.29.0                                                                                  | Verdict                                     |
| ----------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- |
| `dist/harness/pi/index.js`, `context.ts` region       | —                                               | **identical**                                                                           | no change                                   |
| `dist/harness/pi/index.js`, `session-store.ts` region | own inline `Prefixer` + SQLite adapter          | delegates to `@earendil-works/pi-durable/storage/sqlite/cloudflare`                     | rewritten, **same table names** (section 4) |
| `dist/harness/pi/index.js`, `harness.ts` region       | —                                               | one added line: `...options.entry ? { entry: options.entry } : {}`                      | additive, unused                            |
| `dist/harness/pi/index.js`, `skills.ts` region        | `textResult` returns `{ content: [...] }`       | `textResult` returns `{ output: [...] }`                                                | **the one real change**                     |
| `dist/harness/pi/index.d.ts`                          | —                                               | adds `InputEntry` and `PiSubmitOptions.entry`                                           | additive, unused                            |
| `dist/mcp/client/index.js`                            | —                                               | **byte-identical** (`diff -q` clean)                                                    | no change                                   |
| `dist/mcp/client/do-oauth-client-provider.js`         | —                                               | **byte-identical**                                                                      | no change                                   |
| `dist/client-BnYbNT3z.js` (the MCP client core)       | —                                               | **byte-identical** (same content hash)                                                  | no change                                   |
| `dist/lifecycle/index.d.ts`                           | —                                               | **identical**                                                                           | no change                                   |
| `dist/lifecycle-*.js`                                 | —                                               | one added local, one log string changed                                                 | no change (section 4)                       |
| `agents/skills` type exports                          | 27                                              | 24 — drops `ComputerSkillWorkspace`, `LegacySkillWorkspace`, `SkillProjectionWorkspace` | none of the three is used                   |
| `package.json` `exports` map                          | —                                               | **identical**                                                                           | no change                                   |
| `package.json` `dependencies`                         | —                                               | **identical**                                                                           | no change                                   |
| `package.json` `peerDependencies`                     | `pi-ai: ^1.0.0`, `pi-durable: ^1.0.0`           | `pi-ai: ~1.3.0`, `pi-durable: ~1.3.0`                                                   | the only peer change                        |
| `package.json` `peerDependencies` (MCP)               | `sdk: 1.32.1`, `client: 2.3.1`, `server: 2.3.1` | **identical**                                                                           | no change (section 5)                       |

### The `content` → `output` claim, confirmed

`agents@0.28.1`, `dist/harness/pi/index.js:694`:

```js
function textResult(text) {
  return { content: [{ type: "text", text }] };
}
```

`agents@0.29.0`, `dist/harness/pi/index.js:488`:

```js
function textResult(text) {
  return { output: [{ type: "text", text }] };
}
```

The whole `src/harness/pi/skills.ts` region of the pi harness — the extension that publishes
`activate_skill` and `read_skill_resource` — differs between the two versions by **exactly one
line**, that one. The rest of the region (catalog resolution, the activation tool, the resource
reader, the prompt rendering, the tool names) is byte-identical.

## 4. What changed, what did not

### Changed

1. **The skills extension's tool result field.** 0.29.0's pi harness returns `output` where 0.28.1
   returned `content`. Pi Durable 1.3.0 (already pinned) reads `output`. Before the upgrade,
   `adaptLegacyToolOutput` in `packages/control-plane/src/pi/managed-skills-extension.ts` rewrote
   `content` into `output`, so the model saw the same thing either way; the shim existed only to
   bridge the SDK's older output shape. It is deleted, along with its rename guard
   `hasLegacyContent`.

   The one observable difference in the raw tool result: before the upgrade the result carried
   **both** keys (`{ content: [...], output: [...] }`, because the shim spread the original and
   added `output`); after it carries **only** `output` (`{ output: [...] }`). Pi Durable 1.3.0 reads
   `output` and never reads `content`, so the model's view is unchanged. The extra `content` key was
   inert.

2. **Where the pi session store's SQLite adapter comes from.** 0.28.1 shipped its own inline adapter
   inside `dist/harness/pi/index.js` (a `Prefixer` that rewrote SQL identifiers plus a
   `DurableObjectSqliteDatabase`); 0.29.0 delegates to
   `@earendil-works/pi-durable/storage/sqlite/cloudflare`, which the already-pinned Pi Durable 1.3.0
   provides.

   **This does not change the table names**, and it was checked rather than assumed. The two
   mechanisms were compared name by name against the installed `@earendil-works/pi-durable@1.3.0`:

   - 0.28.1's `Prefixer` derived its name set by scanning `SQLITE_MIGRATIONS` for
     `CREATE TABLE|INDEX <name>` and prefixing every match.
   - 1.3.0's `createSqliteSchema(prefix)` prefixes a fixed list (`schema.js`: `durable_schema`,
     `durable_metadata`, `record_ids`, `conversations`, `entries`, `tasks`, `submissions`,
     `documents`, `document_revisions` and 16 indexes).

   Run against the installed package, the regex-derived set and the fixed list are **the same 25
   names** (no member of either is missing from the other), so the prefixed table names are
   identical: `pi_durable_schema`, `pi_durable_metadata`, `pi_record_ids`, `pi_conversations`,
   `pi_entries`, `pi_tasks`, `pi_submissions`, `pi_documents`, `pi_document_revisions`, and the 16
   prefixed indexes.

   Open-Inspect opens the harness with `Harness.open(storage, { models, registry }, context)`
   (`packages/control-plane/src/cloudflare/pi-durable-object.ts:524-531`) and passes **no prefix**,
   so the SDK default `pi_` applies in both versions. **Existing Pi sessions' SQLite data is found
   under the same table names; no data migration is needed and none was performed.**

3. **The Lifecycle chunk's alarm log string.** `dist/lifecycle-*.js` differs by a `counted` local
   that only changes the wording of one `console.error` message when a Durable Object hits the
   platform memory-limit reset. The `install`/`use`/`start`/`fetch` API is identical
   (`dist/lifecycle/index.d.ts` is byte-identical).

### Did not change

- **The MCP broker.** `agents/mcp/client/index.js`, `agents/mcp/client/do-oauth-client-provider.js`
  and the chunk they re-export (`dist/client-BnYbNT3z.js`) are **byte-identical** between the two
  versions, and the worker bundle resolves the same `@modelcontextprotocol/*` files before and after
  (section 7). The broker's behaviour, its transport, its OAuth provider, and its validation are
  untouched.
- **The browser capability.** Never imported from `agents`; unaffected (section 2).
- **The skills extension's surface.** Same extension name (`open-inspect.skills`, set by
  Open-Inspect), same two tools, same names, same parameters, same replay policy, same catalog and
  prompt rendering — the SDK's `skills.ts` region differs by one line.
- **The tool-effect registry.** `activate_skill` and `read_skill_resource` keep their
  `packages/shared/src/pi-tool-effects.ts` entries unchanged.
- **The package's declared dependency surface.** `agents` is the only dependency whose pin changed.
  No peer was added, and none was removed (section 5).

## 5. The peer-dependency finding: the brief's second claim is wrong, and acting on it would break the build

The brief says:

> 2. The upgrade needs the `@modelcontextprotocol/sdk@1.32.1` peer beside the v2
>    `@modelcontextprotocol/client@2.3.1`, which changes the shipped worker bundle's resolution, and
>    npm needs `--legacy-peer-deps` for the peer change.

**The MCP peer requirement is identical in both versions.** Read from the two published tarballs'
`package.json`:

```
agents@0.28.1 peerDependencies:
  "@modelcontextprotocol/sdk":    "1.32.1"
  "@modelcontextprotocol/client": "2.3.1"
  "@modelcontextprotocol/server": "2.3.1"

agents@0.29.0 peerDependencies:
  "@modelcontextprotocol/sdk":    "1.32.1"
  "@modelcontextprotocol/client": "2.3.1"
  "@modelcontextprotocol/server": "2.3.1"
```

The **only** peer change is the narrowing of the two Pi packages:

```
"@earendil-works/pi-ai":      "^1.0.0"  ->  "~1.3.0"
"@earendil-works/pi-durable": "^1.0.0"  ->  "~1.3.0"
```

Both narrowings are satisfied by what Open-Inspect already pins exactly (`pi-ai@1.3.0`,
`pi-durable@1.3.0`), and `~1.3.0` accepts `1.3.0`. So there is **no peer conflict**, **no new peer
to add**, and **no change to the worker's MCP resolution** — the v1 SDK was already resolved before
the upgrade and still is (section 7).

**`--legacy-peer-deps` is not merely unnecessary: it produces a broken tree.** Run in this checkout,
`npm install --legacy-peer-deps` drops the auto-installed peers from the lockfile:

```
REMOVED: node_modules/@modelcontextprotocol/sdk      1.32.1
REMOVED: node_modules/@modelcontextprotocol/server   2.3.1
ADDED:   packages/control-plane/node_modules/agents  0.29.0
```

`@modelcontextprotocol/sdk` is what `agents`' MCP client imports (`dist/client-BnYbNT3z.js` imports
`@modelcontextprotocol/sdk/types.js` — in **both** versions). Without it, the worker bundle cannot
resolve that import. `src/worker-build.test.ts` is exactly the gate that catches this, and it is why
the brief's instinct to reach for `--legacy-peer-deps` needed checking before it was used.

**The real resolver problem is an npm 10 bug, and the repository's own node version does not have
it.** The crash

```
npm error Cannot read properties of null (reading 'edgesOut')
    at #loadPeerSet (arborist/lib/arborist/build-ideal-tree.js:1289:38)
```

is reproducible on **npm 10.9.2** (node 23.11.0) and is **not** a peer conflict. It was isolated by
narrowing only the two Pi peer ranges in the lockfile while leaving `agents` at 0.28.1 — the crash
still occurred, so the trigger is the `^1.0.0` → `~1.3.0` narrowing, not the MCP peers. It is an
`arborist` defect (`node.parent` is null inside `#loadPeerSet`), and a minimal reproduction outside
this repository resolves `agents@0.29.0` with `pi-ai@1.3.0` and `pi-durable@1.3.0` without incident.

The repository declares `node >= 24` (`package.json:35`), `.nvmrc` says `24`, and CI installs node
24 (`.github/workflows/ci.yml:114`) and runs **`npm ci`**, which installs from the lockfile without
re-resolving peers. On **node 24.22.0 / npm 11.19.1**, `npm install` resolves the upgrade cleanly
with **no flags**, and `npm ci` installs the result cleanly. The lockfile in this change is a
**12-line diff** (the `agents` entry: version, resolved URL, integrity, and the two narrowed peer
ranges) — deliberately hand-applied rather than regenerated, so the diff does not carry npm 11's
unrelated `dev` → `devOptional` rewrites of ~200 unrelated entries.

**The rule for the next reader: on this repository, use the declared node version (24) and `npm ci`.
Do not reach for `--legacy-peer-deps`; it removes the MCP peers the worker needs.**

## 6. What was changed in the tree

```
packages/control-plane/package.json          "agents": "0.28.1" -> "0.29.0"
package-lock.json                             the agents entry: version, resolved, integrity,
                                             and the two narrowed pi peer ranges (6 lines)
packages/control-plane/src/pi/managed-skills-extension.ts
                                             adaptLegacyToolOutput deleted
                                             hasLegacyContent deleted
                                             the tools: extension.tools?.map(...) override deleted
packages/control-plane/src/pi/managed-skills-extension.test.ts
                                             the mock now returns output, as 0.29.0 does
packages/control-plane/test/integration/pi-skills-extension.test.ts
                                             new: the SDK contract, checked against the
                                             installed SDK rather than a mock
features/pi-first-class/PI-AGENTS-UPGRADE-AUDIT.md
                                             this document
```

`managed-skills-extension.ts` after the change:

```ts
import { defineExtension } from "@earendil-works/pi-durable";
import type { SkillSource } from "agents/skills";

/**
 * Install the official Agents Pi skills extension over Open-Inspect's pinned
 * sources. Agents 0.29.0's pi harness returns tool results in Pi Durable's
 * `output` contract, so the extension is installed as the SDK defines it;
 * catalog resolution, activation, resources, and prompt rendering remain the
 * SDK implementation.
 */
export async function createManagedSkillsExtension(sources: readonly SkillSource[]) {
  const { skills } = await import("agents/harness/pi");
  const extension = await skills(sources);
  return defineExtension({
    ...extension,
    name: "open-inspect.skills",
  });
}
```

The extension's name is still Open-Inspect's (`open-inspect.skills`); the tools are the SDK's own
objects, with the SDK's own names. The `tools` override existed only to wrap `execute`; with the
output contract aligned there is nothing left to wrap.

The unit test's mock of `agents/harness/pi` was returning the **0.28.1** shape (`content`) and
asserting the **0.29.0** shape (`output`) — it was passing because of the shim. The mock now returns
`output`, so the test asserts the contract the installed SDK actually has.

### The new test: the SDK contract, checked against the SDK

A mock can only ever assert what Open-Inspect believes the SDK does. The old unit test was exactly
that, and it hid one thing: its mock invented an `isError: true` flag on a missing skill resource
that **the SDK never sets**. The real SDK refuses a traversing path with a plain text result ("Skill
resource not found: review/../secret") and no error flag — and it did so identically in 0.28.1,
since the SDK's `skills.ts` region is byte-identical between the two versions apart from
`textResult`. The mock's flag was a fiction, harmless but untested against reality.

`packages/control-plane/test/integration/pi-skills-extension.test.ts` closes that gap. It runs in
the workerd pool (the pi harness imports `cloudflare:workers`, so it cannot run in plain node),
imports the **installed** `agents/harness/pi`, and asserts:

1. the extension is named `open-inspect.skills` and publishes exactly `activate_skill` and
   `read_skill_resource`;
2. a tool result carries `output` and **not** `content` — the contract the shim used to bridge;
3. a declared resource reads back, and a traversing path is refused without disclosing the bundle's
   content.

Against 0.28.1 **with the shim removed**, assertion 2 fails, and the failure shows the SDK's own
result:

```
- Expected
+ Received
  {
-   "output": [ ObjectContaining { "text": StringContaining "Check tests." … } ],
+   "content": [
+     {
+       "text": "<skill_resource name=\"review\" path=\"references/checklist.md\" …>\nCheck tests.\n</skill_resource>",
+       "type": "text",
+     },
+   ],
  }
```

(Verified by running the new test in the pre-upgrade worktree with the shim deleted: 2 of the 3
assertions fail; the tool-name assertion passes, because the names never changed.) That is the
point: the guard now fails loudly if a future SDK bump reintroduces the mismatch, instead of the
mismatch being papered over by an adapter.

## 7. The worker bundle's resolution, before and after

From `packages/control-plane/dist/meta.json`, the input list of `npm run build:worker`:

|              |                                                                             |
| ------------ | --------------------------------------------------------------------------- |
| Total inputs | 2245 → 2245                                                                 |
| Removed      | `node_modules/@earendil-works/pi-durable/dist/storage/sqlite/index.js`      |
| Removed      | `node_modules/agents/dist/lifecycle-DGorpAmA.js`                            |
| Added        | `node_modules/@earendil-works/pi-durable/dist/storage/sqlite/cloudflare.js` |
| Added        | `node_modules/agents/dist/lifecycle-ClT4DmF2.js`                            |

Everything else is unchanged, including every MCP file:

```
@modelcontextprotocol/client/dist/cfWorkerProvider-BylNJ1R5.mjs
@modelcontextprotocol/client/dist/chunk-Br0eD_fh.mjs
@modelcontextprotocol/client/dist/dialects-BOhdv1Fc.mjs
@modelcontextprotocol/client/dist/index.mjs
@modelcontextprotocol/client/dist/shimsWorkerd.mjs
@modelcontextprotocol/client/dist/src-WCy6ifGf.mjs
@modelcontextprotocol/client/dist/validators/cfWorker.mjs
@modelcontextprotocol/core/dist/auth-BNDyLTqp.mjs
@modelcontextprotocol/core/dist/internal.mjs
@modelcontextprotocol/sdk/dist/esm/types.js        <-- the v1 SDK, before and after
```

The two changes are the two expected ones: the pi session store's adapter moved from the `agents`
barrel to Pi Durable's own `storage/sqlite/cloudflare` (section 4), and the Lifecycle chunk was
re-hashed (its content differs only in one log string). The `agents` inputs are otherwise identical,
and in particular:

- `agents/dist/harness/pi/index.js` — the pi harness, with the `content` → `output` change.
- `agents/dist/mcp/client/index.js`, `agents/dist/mcp/client/do-oauth-client-provider.js`,
  `agents/dist/client-BnYbNT3z.js` — **the same files, unchanged**.
- **No** `agents/dist/skills/index.js` and **no** `agents/dist/browser-*.js` — neither the skills
  runtime nor the browser is in the bundle (section 2).

## 8. Test results

Run on **node 24.22.0 / npm 11.19.1** (the repository's declared version), after
`npm run build -w @open-inspect/shared`, on the tree as committed (rebased onto
`feat/pi-go-live-integration-v2` at `b23780cd`).

| Lane                                | Command                                                                                             | Result                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| shared build                        | `npm run build -w @open-inspect/shared`                                                             | pass                                           |
| control-plane unit                  | `npm test -w @open-inspect/control-plane`                                                           | **339 files / 5430 passed, 1 skipped**         |
| **worker-build gate**               | `npx vitest run src/worker-build.test.ts --root packages/control-plane`                             | **1 passed**                                   |
| typecheck                           | `npm run typecheck`                                                                                 | pass (all workspaces, including `web`)         |
| lint                                | `npm run lint`                                                                                      | pass                                           |
| format                              | `npm run format:check`                                                                              | pass                                           |
| shared unit                         | `npm test -w @open-inspect/shared`                                                                  | 1 failure, in the base's own change; see below |
| web unit                            | `npm test -w @open-inspect/web`                                                                     | 229/233 files passed; see below                |
| control-plane integration (workerd) | `npm run test:integration -w @open-inspect/control-plane`                                           | 171/174 files passed; see below                |
| the pi, skills, and MCP suites      | the seven files listed below                                                                        | **7 files / 147 passed**                       |
| the SDK contract, against the SDK   | `npx vitest run --config vitest.integration.config.ts test/integration/pi-skills-extension.test.ts` | **3 passed**                                   |

**The worker-build gate passes.** It is the check that would have caught a resolution mistake such
as the one `--legacy-peer-deps` causes, and it passes on the tree as committed.

### The base branch's one remaining failure, which this change does not cause

The base branch `feat/pi-go-live-integration-v2` has a failing test of its own. It was verified to
be present on the base **without** this change, in a separate worktree checked out at `b23780cd`:

```
FAIL src/pi-tool-effects.test.ts > Pi tool effect registry >
     declares Code Mode and its reserved internal model tools before exposure
Test Files  1 failed | 62 passed (63)
```

It comes from the base's own `packages/shared/src/pi-tool-effects.ts` change. **It is not caused by
this change and is not fixed by it** — it belongs to the base branch, and is recorded here so the
next reader does not attribute it to the upgrade. The shared package has no dependency path to
`agents` at all. Every file this change touches lints, formats, and type-checks clean.

(The base branch also carried two temporary scratch scripts that failed lint and format; its own
later commits removed them, and `npm run lint` and `npm run format:check` now pass on the merged
tree.)

### The web lane's failures are load-induced timeouts, and they are not in the blast radius

The web lane's failures are all `Test timed out in 5000ms` in slow React component files
(`team-channels.test.tsx`, `page-team-context.test.tsx`, `automation-form.test.tsx`,
`linear-integration-settings.test.tsx`), the failing set **changes between runs** (6 files / 15
tests on one run, 4 files / 5 tests on the next), and **all four files pass in isolation**
(152/152). The web package has **no dependency path to `agents`** at all
(`packages/web/package.json` has no `agents` entry; the lockfile's `packages/web` entry has none
either), so the upgrade cannot reach it.

### The integration lane's failures are the same kind of timeouts — and the pre-upgrade tree fails them too

Same signature: `Test timed out in 5000ms`, in `child-session-ops.test.ts`,
`websocket-client.test.ts` and `session-export.test.ts` — session/websocket plumbing, not the pi
harness, the skills extension, or the MCP broker — with the failing set changing between runs.

**The control settles it.** The same lane was run on the **pre-upgrade** commit (`a6ab76de`,
`agents@0.28.1`) in a separate worktree, under the same machine load:

```
baseline (agents@0.28.1):  Test Files  1 failed | 173 passed (174)
                           Tests       3 failed | 2472 passed | 1 skipped (2476)
                           FAIL test/integration/teams-routes.test.ts > returns null team
                                capabilities across memberships (...)
                           Error: Test timed out in 5000ms.
```

The pre-upgrade tree fails the lane too, with the identical timeout signature, in a **different**
file. The failures are pre-existing and load-induced, not caused by the upgrade.

**The machine was not idle.** A second agent's worktree (`pi-mcp-oauth`) was running its own workerd
integration lane on the same host throughout these runs, and the baseline run was deliberately
executed alongside it. The load average was 10.65 / 15.24 / 17.31. Both lanes are CPU-bound and the
failures are 5-second timeouts in the slowest files, which is the signature of an overloaded host
rather than of a defect. CI shards the integration lane in two (`.github/workflows/ci.yml:286`) and
runs it on a dedicated runner, so it does not see this load.

### The pi, skills, and MCP integration tests all pass on the upgraded tree

Run directly, under the same load, the seven files that cover everything the upgrade touches:

```
npx vitest run --config vitest.integration.config.ts \
  test/integration/pi-session-do.test.ts \
  test/integration/pi-session-creation.test.ts \
  test/integration/pi-skills-extension.test.ts \
  test/integration/managed-skills.test.ts \
  test/integration/skill-imports.test.ts \
  test/integration/mcp-connections.test.ts \
  test/integration/mcp-servers.test.ts

Test Files  7 passed (7)
Tests       147 passed (147)
```

`pi-session-do.test.ts` includes the Durable Object eviction path, so the pi session store — the one
place the upgrade rewrote the storage adapter — is exercised end to end on 0.29.0.

## 9. UNVERIFIED

Honest list of what this audit did **not** establish.

1. **That the failing _web_ tests fail on the pre-upgrade tree too.** The integration lane's
   failures _are_ now settled — the pre-upgrade tree fails them too, with the same timeout signature
   (section 8). The web lane's failures were not given the same control run. The evidence for them
   is that they are 5-second timeouts in the slowest React component files, that the failing set
   changes between runs, that all four files pass in isolation (152/152), and that the web package
   has no dependency path to `agents` at all. That is strong evidence, not a control run.
2. **That the pi session store's SQLite tables are byte-identical at runtime under workerd.** The
   name-set equivalence is proven at the source level (section 4) and the integration lane exercises
   `PiSessionDO`, but no test in the repository asserts the physical table names, so "no data
   migration" rests on the source proof rather than on an observed table listing.
3. **That CI's npm 11 patch version behaves like npm 11.19.1.** The lockfile is standard
   lockfileVersion 3 and `npm ci` does not re-resolve peers, so the risk is low, but CI pins
   `node-version: "24.0.0"` in `.github/workflows/ci.yml:114` and the exact npm that ships with it
   was not exercised here.
4. **That `agents@0.29.0` has no behaviour change outside the five imported entry points.** The
   audit covered the imported surfaces exhaustively and the bundle's `agents` inputs exhaustively.
   The rest of the package changed (`dist/browser-*.js`, `dist/skills/index.js`, `dist/index.js`,
   and others) and that change is **not** characterised here — it is simply not reachable from
   Open-Inspect, which the bundle input list demonstrates.
5. **Runtime equivalence of the two SQLite adapters under a mid-transaction eviction.** Both
   adapters were read: they differ in internal queueing (`OperationQueue` vs `SerialQueue`) but
   present the same `SqliteDatabase` contract to Pi Durable, and they produce the same table names
   (section 4). The Durable Object eviction path **is** exercised — `pi-session-do.test.ts` aborts
   the object mid-flight in three tests and all pass on 0.29.0 — but no test evicts the object
   _inside_ an open SQLite transaction, so that specific interleaving is not covered.

## 10. Corrections to the repository's own documents

Two documents in `features/pi-first-class/` described the upgrade as pending and, in the brief's
case, described the peer step incorrectly. They are corrected in this change:

- `features/pi-first-class/PI-UPSTREAM-PARITY.md` — the section "The one place Open-Inspect lags:
  `agents` 0.28.1 against 0.29.0" said the upgrade was "deliberately not done in this change" and
  listed the `--legacy-peer-deps` step. It now records the upgrade as taken, with the corrected
  resolution facts.
- `features/pi-first-class/PI-REMAINING-AUDIT-BRIEFS.md` — section 7's claim 2 is corrected: the MCP
  peer requirement is unchanged between the two versions, no peer needs to be added, and
  `--legacy-peer-deps` removes the MCP peers the worker needs. The repository's own node version
  (24) resolves the change without it.

## 11. Verdict

**The upgrade is safe.** It is taken.

- The only behavioural change the SDK makes to anything Open-Inspect uses is the tool-result field
  the shim was already bridging, which the shim's removal keeps invisible.
- The pi session store's physical table names are unchanged, so no session data is stranded.
- The MCP broker's code and resolution are byte-identical.
- The browser capability does not touch `agents`.
- The worker bundle's resolution changes by four files, all accounted for.
- The lockfile diff is twelve lines.
- The pi, skills, and MCP integration suites pass on the upgraded tree (147 tests), including the
  Durable Object eviction path.
- The new workerd test pins the SDK's tool names and result contract against the **installed** SDK,
  so the mismatch this upgrade removes cannot silently return.

The one thing a future reader must not do is reach for `--legacy-peer-deps`: it removes the
`@modelcontextprotocol/sdk` and `@modelcontextprotocol/server` peers from the tree, and the worker
bundle will not resolve without them.
