import { describe, expect, it, vi } from "vitest";
import { MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION } from "../sandbox/runtime-manifest";
import { GENERATION, fixture, readyFinite } from "./sandbox-shutdown.test-helpers";

describe("adopting a generation the coordinator never started", () => {
  // A control-plane deploy that lands while a sandbox is already serving leaves
  // that generation with no record at all: reserveStartup is the only writer of
  // an initial record and it runs on spawn, restore and resume. Unadopted, the
  // generation has no owner and the ordered shutdown that exists to guarantee a
  // recovery point never applies to it.
  const CAPABLE = `v${MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION}-capable`;
  const BELOW_FLOOR = `v${MIN_SHUTDOWN_PROTOCOL_RUNTIME_GENERATION - 1}-below-floor`;

  it("adopts a live sandbox with no record on the next alarm", async () => {
    const f = fixture();
    f.sandboxRow.runtime_version = CAPABLE;
    expect(f.store.value).toBeNull();

    await f.shutdown.handleAlarm();

    expect(f.store.value).toMatchObject({
      phase: "running",
      generation: GENERATION,
      providerObjectId: "provider-object-1",
      lifetimeKind: "unknown",
      expiresAtMs: null,
      drainAtMs: null,
      generationReady: false,
      lifecyclePolicy: "legacy",
    });
    expect(f.log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "sandbox.preservation_adopted" })
    );
  });

  // The whole point of adopting conservatively. A "confirmed" record would fail
  // the admission gate's lifetime/handshake test and hold every dispatch, so
  // adopting a healthy session would silently stop it working.
  it("keeps admitting work on an adopted generation", async () => {
    const f = fixture();
    f.sandboxRow.runtime_version = CAPABLE;

    await f.shutdown.handleAlarm();

    expect(f.store.value).toMatchObject({ lifecyclePolicy: "legacy" });
    expect(f.shutdown.admissionDecision()).toBe("ready");
    expect(f.shutdown.isHolding()).toBe(false);
  });

  it("adopts a below-floor runtime the same way, since neither can handshake", async () => {
    const f = fixture();
    f.sandboxRow.runtime_version = BELOW_FLOOR;

    await f.shutdown.handleAlarm();

    expect(f.store.value).toMatchObject({ lifecyclePolicy: "legacy" });
    expect(f.shutdown.admissionDecision()).toBe("ready");
  });

  it("does not adopt a sandbox that is not serving", async () => {
    const f = fixture();
    f.sandboxRow.status = "stopped";

    await f.shutdown.handleAlarm();

    expect(f.store.value).toBeNull();
    expect(f.log.warn).not.toHaveBeenCalled();
  });

  it("adopts only once, leaving the adopted record intact on later alarms", async () => {
    const f = fixture();
    f.sandboxRow.runtime_version = CAPABLE;

    await f.shutdown.handleAlarm();
    const adopted = structuredClone(f.store.value);
    await f.shutdown.handleAlarm();

    expect(f.store.value).toEqual(adopted);
    expect(f.log.warn).toHaveBeenCalledTimes(1);
  });

  it("routes an adopted generation's shutdown to the preserving legacy path", async () => {
    const f = fixture();
    f.sandboxRow.runtime_version = CAPABLE;
    await f.shutdown.handleAlarm();

    // "unmanaged" sends the caller to the snapshot path, which preserves state.
    // Draining toward a confirmation this generation cannot send would strand it.
    expect(await f.shutdown.requestShutdown("inactivity_timeout")).toBe("unmanaged");
    expect(f.store.value).toMatchObject({ phase: "running" });
  });

  it("adopts on a runtime announcement that arrives with no record", () => {
    const f = fixture();
    f.sandboxRow.runtime_version = CAPABLE;

    f.shutdown.runtimeReady(1);

    expect(f.store.value).toMatchObject({
      phase: "running",
      lifecyclePolicy: "legacy",
      runtimeReady: true,
    });
    expect(f.log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "sandbox.preservation_adopted" })
    );
    expect(f.shutdown.admissionDecision()).toBe("ready");
  });

  it("still reports a genuinely unmanaged session when there is no sandbox at all", async () => {
    const f = fixture();
    f.deps.sandbox.getSandbox = vi.fn(() => null) as never;

    expect(await f.shutdown.requestShutdown("inactivity_timeout")).toBe("unmanaged");
    expect(f.store.value).toBeNull();
  });

  it("leaves a generation this coordinator did start on the ordered path", async () => {
    const f = fixture();
    await readyFinite(f);

    expect(f.log.warn).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "sandbox.preservation_adopted" })
    );
    expect(f.store.value).toMatchObject({ lifecyclePolicy: "confirmed" });
    expect(await f.shutdown.requestShutdown("inactivity_timeout")).toBe("owned");
  });
});
