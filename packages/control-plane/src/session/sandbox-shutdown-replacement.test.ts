import { describe, expect, it, vi } from "vitest";
import { SandboxShutdownCoordinator } from "./sandbox-shutdown";
import type { ShutdownRecord } from "./sandbox-shutdown-repository";
import { SANDBOX_REPLACED_ERROR } from "./interruption-messages";

/** A coordinator over one sandbox row whose transaction reports what ran inside it. */
function fixture(processing: { id: string } | null = { id: "msg-running" }) {
  const row = { modal_sandbox_id: "sandbox-old", created_at: 1_000 };
  const order: string[] = [];
  let inTransaction = false;
  let record: ShutdownRecord | null = null;
  const failure = { event: { messageId: processing?.id }, completion: {} };
  const deps = {
    store: { read: () => record, write: (next: ShutdownRecord) => (record = next) },
    provider: { name: "modal" },
    sandbox: { getSandbox: vi.fn(() => row) },
    session: {
      transaction: vi.fn(<T>(operation: () => T): T => {
        inTransaction = true;
        try {
          return operation();
        } finally {
          inTransaction = false;
        }
      }),
    },
    messages: { getProcessingMessage: vi.fn(() => processing) },
    failures: {
      record: vi.fn(() => {
        order.push(inTransaction ? "record:in-transaction" : "record:after-commit");
        return failure;
      }),
      deliver: vi.fn(() => {
        order.push(inTransaction ? "deliver:in-transaction" : "deliver:after-commit");
      }),
    },
    messenger: { broadcast: vi.fn() },
    background: { submit: vi.fn() },
    reconcileStatusFromMessages: vi.fn(async () => undefined),
    now: () => 5_000,
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const shutdown = new SandboxShutdownCoordinator(deps as never);
  const reserve = (persist: () => void) => shutdown.reserveStartup(2_000, "confirmed", persist);
  const replace = () => {
    row.modal_sandbox_id = "sandbox-new";
    row.created_at = 2_000;
  };
  const resumeInPlace = () => {
    row.created_at = 2_000;
  };
  return { deps, order, failure, reserve, replace, resumeInPlace };
}

describe("reserveStartup on sandbox replacement", () => {
  it("fails the processing prompt in the transaction that replaces the sandbox ID", () => {
    const f = fixture();

    f.reserve(f.replace);

    expect(f.deps.failures.record).toHaveBeenCalledExactlyOnceWith(
      "msg-running",
      SANDBOX_REPLACED_ERROR,
      5_000,
      "processing"
    );
    expect(f.order).toEqual(["record:in-transaction", "deliver:after-commit"]);
    expect(f.deps.failures.deliver).toHaveBeenCalledWith(f.failure);
    expect(f.deps.messenger.broadcast).toHaveBeenCalledWith({
      type: "processing_status",
      isProcessing: false,
    });
    expect(f.deps.background.submit).toHaveBeenCalledOnce();
  });

  it("keeps the processing prompt across an in-place resume of the same sandbox ID", () => {
    const f = fixture();

    f.reserve(f.resumeInPlace);

    expect(f.deps.messages.getProcessingMessage).not.toHaveBeenCalled();
    expect(f.deps.failures.record).not.toHaveBeenCalled();
    expect(f.deps.failures.deliver).not.toHaveBeenCalled();
  });

  it("announces nothing when no prompt is processing", () => {
    const f = fixture(null);

    f.reserve(f.replace);

    expect(f.deps.failures.record).not.toHaveBeenCalled();
    expect(f.deps.messenger.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "processing_status" })
    );
    expect(f.deps.background.submit).not.toHaveBeenCalled();
  });

  it("fails the reservation transaction when the prompt cannot be settled", () => {
    const f = fixture();
    f.deps.failures.record.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });

    // Throwing out of the transaction rolls the revocation back with it.
    expect(() => f.reserve(f.replace)).toThrow("storage unavailable");
    expect(f.deps.failures.deliver).not.toHaveBeenCalled();
  });
});
