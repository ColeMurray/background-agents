import { RemoteCodemodeSandbox, type CodemodeHostCall } from "@earendil-works/pi-codemode/portable";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function remoteSandbox(
  name: string,
  tools: ConstructorParameters<typeof RemoteCodemodeSandbox>[0]["tools"] = []
) {
  if (!env.CODEMODE_SANDBOX) throw new Error("CODEMODE_SANDBOX test binding is missing");
  return new RemoteCodemodeSandbox({
    tools,
    remote: () => env.CODEMODE_SANDBOX!.getByName(name),
  });
}

describe("remote Pi Code Mode sandbox", () => {
  it("executes in the separately compiled auxiliary Worker", async () => {
    const sandbox = remoteSandbox(`execute-${crypto.randomUUID()}`, [
      {
        name: "read",
        execute: ({ path }) => `contents:${String(path)}`,
      },
    ]);

    await expect(
      sandbox.execute('text(await tools.read({ path: "README.md" })); return 42;')
    ).resolves.toMatchObject({
      ok: true,
      value: 42,
      output: [{ type: "text", text: "contents:README.md" }],
      calls: [{ name: "read", status: "ok" }],
    });

    await sandbox.close();
  });

  it("replays deterministically with a stable VM fingerprint", async () => {
    const sandbox = remoteSandbox(`replay-${crypto.randomUUID()}`);

    async function runOnce() {
      const calls: CodemodeHostCall[] = [];
      let fingerprint = "";
      const run = sandbox.start("return await tools.read({ path: Math.random().toString() });", {
        startedAt: 1_700_000_000_000,
        seed: 17,
        tools: [{ name: "read" }],
        onStarted: (value) => {
          fingerprint = value;
        },
        onCall: (call) => {
          calls.push(call);
          queueMicrotask(() =>
            run.deliver(1, 1_700_000_000_001, call.id, { ok: true, value: "ok" })
          );
        },
      });
      const result = await run.result;
      return { fingerprint, calls, result };
    }

    const first = await runOnce();
    const replay = await runOnce();

    expect(first.fingerprint).not.toBe("");
    expect(replay.fingerprint).toBe(first.fingerprint);
    expect(replay.calls).toEqual(first.calls);
    expect(replay.result).toMatchObject({
      ok: true,
      value: "ok",
      output: first.result.output,
      during: first.result.during,
      calls: [{ name: "read", status: "ok" }],
    });
    await sandbox.close();
  });

  it("propagates aborts to pending nested tools", async () => {
    let toolStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let nestedSignal: AbortSignal | undefined;
    const sandbox = remoteSandbox(`abort-${crypto.randomUUID()}`, [
      {
        name: "wait",
        execute: (_args, { signal }) => {
          nestedSignal = signal;
          toolStarted?.();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    ]);
    const controller = new AbortController();
    const execution = sandbox.execute("await tools.wait({});", { signal: controller.signal });
    await started;

    controller.abort(new Error("stop test"));

    await expect(execution).resolves.toMatchObject({ ok: false, error: { kind: "aborted" } });
    expect(nestedSignal?.aborted).toBe(true);
    await sandbox.close();
  });

  it("closes active executions without waiting for the remote VM", async () => {
    let toolStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const sandbox = remoteSandbox(`close-${crypto.randomUUID()}`, [
      {
        name: "wait",
        execute: (_args, { signal }) => {
          toolStarted?.();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    ]);
    const execution = sandbox.execute("await tools.wait({});");
    await started;

    await sandbox.close();

    await expect(execution).resolves.toMatchObject({ ok: false, error: { kind: "aborted" } });
  });
});
