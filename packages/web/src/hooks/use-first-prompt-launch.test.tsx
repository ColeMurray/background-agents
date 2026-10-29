// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FirstPromptDelivery } from "@/lib/first-prompt-delivery";
import { DEFAULT_ATTACHMENT_ONLY_MESSAGE } from "./use-session-attachments";
import { useFirstPromptLaunch } from "./use-first-prompt-launch";

const input: Parameters<typeof useFirstPromptLaunch>[0] = {
  prompt: "  Fix the bug  ",
  model: "openai/gpt-5.4",
  reasoningEffort: "high",
  hasAttachments: false,
  blocked: false,
  validationError: null,
};
const uploaded = [{ attachmentId: "attachment-1", name: "screenshot.png" }];

function collaborators() {
  return {
    sessions: {
      warm: vi.fn<() => Promise<string | null>>().mockResolvedValue("session-1"),
      consume: vi.fn(),
    },
    attachments: { uploadAll: vi.fn().mockResolvedValue(uploaded) },
    delivery: { send: vi.fn<FirstPromptDelivery["send"]>().mockResolvedValue({ ok: true }) },
    completion: { launched: vi.fn(), denied: vi.fn() },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("useFirstPromptLaunch", () => {
  it("acquires, uploads, sends, consumes, then completes once despite synchronous duplicate submits", async () => {
    const deps = collaborators();
    const acquisition = deferred<string>();
    const upload = deferred<typeof uploaded>();
    const delivery = deferred<{ ok: true }>();
    deps.sessions.warm.mockReturnValue(acquisition.promise);
    deps.attachments.uploadAll.mockReturnValue(upload.promise);
    deps.delivery.send.mockReturnValue(delivery.promise);
    const { result } = renderHook(() =>
      useFirstPromptLaunch({ ...input, hasAttachments: true }, deps)
    );
    let submissions: Promise<void>[] = [];

    act(() => {
      submissions = [result.current.submit(), result.current.submit()];
    });
    expect(result.current.submitting).toBe(true);
    expect(deps.sessions.warm).toHaveBeenCalledOnce();
    expect(deps.attachments.uploadAll).not.toHaveBeenCalled();
    expect(deps.delivery.send).not.toHaveBeenCalled();

    await act(async () => acquisition.resolve("session-1"));
    expect(deps.attachments.uploadAll).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(deps.delivery.send).not.toHaveBeenCalled();

    await act(async () => upload.resolve(uploaded));
    expect(deps.delivery.send).toHaveBeenCalledExactlyOnceWith("session-1", {
      content: "Fix the bug",
      model: input.model,
      reasoningEffort: "high",
      attachments: uploaded,
    });
    expect(deps.sessions.consume).not.toHaveBeenCalled();
    expect(deps.completion.launched).not.toHaveBeenCalled();
    expect(result.current.submitting).toBe(true);

    await act(async () => {
      delivery.resolve({ ok: true });
      await Promise.all(submissions);
    });
    expect(deps.sessions.consume).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(deps.completion.launched).toHaveBeenCalledExactlyOnceWith("session-1", input.prompt);
    expect(deps.sessions.consume.mock.invocationCallOrder[0]).toBeLessThan(
      deps.completion.launched.mock.invocationCallOrder[0]
    );
    expect(deps.completion.denied).not.toHaveBeenCalled();
    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBe("");
  });

  it("delivers attachment-only prompts with the default message", async () => {
    const deps = collaborators();
    const { result } = renderHook(() =>
      useFirstPromptLaunch({ ...input, prompt: " \n ", hasAttachments: true }, deps)
    );

    await act(async () => result.current.submit());

    expect(deps.delivery.send).toHaveBeenCalledExactlyOnceWith("session-1", {
      content: DEFAULT_ATTACHMENT_ONLY_MESSAGE,
      model: input.model,
      reasoningEffort: "high",
      attachments: uploaded,
    });
    expect(deps.completion.launched).toHaveBeenCalledWith("session-1", " \n ");
  });

  it("does not send, consume, or complete after upload failure and retries through the same session collaborator", async () => {
    const deps = collaborators();
    deps.attachments.uploadAll.mockRejectedValueOnce(new Error("Upload failed"));
    const { result } = renderHook(() =>
      useFirstPromptLaunch({ ...input, hasAttachments: true }, deps)
    );

    await act(async () => result.current.submit());

    expect(deps.delivery.send).not.toHaveBeenCalled();
    expect(deps.sessions.consume).not.toHaveBeenCalled();
    expect(deps.completion.launched).not.toHaveBeenCalled();
    expect(deps.completion.denied).not.toHaveBeenCalled();
    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBe("");

    await act(async () => result.current.submit());

    expect(deps.sessions.warm).toHaveBeenCalledTimes(2);
    expect(deps.attachments.uploadAll.mock.calls).toEqual([["session-1"], ["session-1"]]);
    expect(deps.delivery.send).toHaveBeenCalledOnce();
    expect(deps.sessions.consume).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(deps.completion.launched).toHaveBeenCalledExactlyOnceWith("session-1", input.prompt);
  });

  it.each(["error", "forbidden", "network"] as const)(
    "retains the draft on delivery %s, only notifies for forbidden, and releases the retry lock",
    async (failure) => {
      const deps = collaborators();
      if (failure === "network") {
        deps.delivery.send.mockRejectedValueOnce(new Error("Offline"));
      } else {
        deps.delivery.send.mockResolvedValueOnce({
          ok: false,
          message: "Cannot send prompt",
          forbidden: failure === "forbidden",
        });
      }
      const { result } = renderHook(() => useFirstPromptLaunch(input, deps));

      await act(async () => result.current.submit());

      expect(result.current.error).toBe(
        failure === "network" ? "Failed to create session" : "Cannot send prompt"
      );
      expect(result.current.submitting).toBe(false);
      expect(deps.attachments.uploadAll).not.toHaveBeenCalled();
      expect(deps.sessions.consume).not.toHaveBeenCalled();
      expect(deps.completion.launched).not.toHaveBeenCalled();
      if (failure === "forbidden") {
        expect(deps.completion.denied).toHaveBeenCalledExactlyOnceWith("Cannot send prompt");
      } else {
        expect(deps.completion.denied).not.toHaveBeenCalled();
      }

      await act(async () => result.current.submit());

      expect(deps.sessions.warm).toHaveBeenCalledTimes(2);
      expect(deps.delivery.send).toHaveBeenLastCalledWith("session-1", {
        content: "Fix the bug",
        model: input.model,
        reasoningEffort: "high",
      });
      expect(deps.sessions.consume).toHaveBeenCalledExactlyOnceWith("session-1");
      expect(deps.completion.launched).toHaveBeenCalledExactlyOnceWith("session-1", input.prompt);
      expect(result.current.error).toBe("");
    }
  );

  it("uses the captured request, collaborators, and acquired session when rerendered while pending", async () => {
    const original = collaborators();
    const replacement = collaborators();
    replacement.sessions.warm.mockResolvedValue("replacement-session");
    const acquisition = deferred<string>();
    original.sessions.warm.mockReturnValue(acquisition.promise);
    const { result, rerender } = renderHook(
      ({ request, deps }) => useFirstPromptLaunch(request, deps),
      { initialProps: { request: { ...input, hasAttachments: true }, deps: original } }
    );
    let submission: Promise<void> | undefined;
    act(() => {
      submission = result.current.submit();
    });

    rerender({
      request: {
        ...input,
        prompt: "New draft",
        model: "openai/gpt-5.5",
        reasoningEffort: "low",
        hasAttachments: false,
      },
      deps: replacement,
    });
    await act(async () => {
      acquisition.resolve("captured-session");
      await submission;
    });

    expect(original.attachments.uploadAll).toHaveBeenCalledWith("captured-session");
    expect(original.delivery.send).toHaveBeenCalledExactlyOnceWith("captured-session", {
      content: "Fix the bug",
      model: input.model,
      reasoningEffort: "high",
      attachments: uploaded,
    });
    expect(original.sessions.consume).toHaveBeenCalledExactlyOnceWith("captured-session");
    expect(original.completion.launched).toHaveBeenCalledExactlyOnceWith(
      "captured-session",
      input.prompt
    );
    expect(replacement.sessions.warm).not.toHaveBeenCalled();
    expect(replacement.attachments.uploadAll).not.toHaveBeenCalled();
    expect(replacement.delivery.send).not.toHaveBeenCalled();
    expect(replacement.sessions.consume).not.toHaveBeenCalled();
    expect(replacement.completion.launched).not.toHaveBeenCalled();
    expect(result.current.submitting).toBe(false);
  });

  it("stops before upload and delivery when acquisition returns null for a stale draft", async () => {
    const deps = collaborators();
    deps.sessions.warm.mockResolvedValue(null);
    const { result } = renderHook(() =>
      useFirstPromptLaunch({ ...input, hasAttachments: true }, deps)
    );

    await act(async () => result.current.submit());

    expect(deps.attachments.uploadAll).not.toHaveBeenCalled();
    expect(deps.delivery.send).not.toHaveBeenCalled();
    expect(deps.sessions.consume).not.toHaveBeenCalled();
    expect(deps.completion.launched).not.toHaveBeenCalled();
    expect(deps.completion.denied).not.toHaveBeenCalled();
    expect(result.current.error).toBe("Failed to create session");
    expect(result.current.submitting).toBe(false);
  });

  it("checks blocked, empty, and invalid requests before acquiring a session", async () => {
    const deps = collaborators();
    const { result, rerender } = renderHook((request) => useFirstPromptLaunch(request, deps), {
      initialProps: input,
    });

    for (const request of [
      { ...input, blocked: true },
      { ...input, prompt: " \n " },
      { ...input, validationError: "Select a repository" },
    ]) {
      rerender(request);
      await act(async () => result.current.submit());
      expect(result.current.error).toBe(request.validationError ?? "");
      expect(result.current.submitting).toBe(false);
    }

    expect(deps.sessions.warm).not.toHaveBeenCalled();
    expect(deps.attachments.uploadAll).not.toHaveBeenCalled();
    expect(deps.delivery.send).not.toHaveBeenCalled();
    expect(deps.sessions.consume).not.toHaveBeenCalled();
    expect(deps.completion.launched).not.toHaveBeenCalled();
    expect(deps.completion.denied).not.toHaveBeenCalled();
  });
});
