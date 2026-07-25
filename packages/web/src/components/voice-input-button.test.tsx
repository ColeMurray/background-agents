// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { VoiceInputButton } from "./voice-input-button";

expect.extend(matchers);

const stopTrack = vi.fn();

class MediaRecorderMock {
  static isTypeSupported() {
    return true;
  }

  mimeType = "audio/webm";
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  }
}

beforeEach(() => {
  stopTrack.mockReset();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
    },
  });
  vi.stubGlobal("MediaRecorder", MediaRecorderMock);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ text: "Inspect useSessionSocket next." }))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("records one utterance and returns its transcript for editing", async () => {
  const user = userEvent.setup();
  const onTranscript = vi.fn();
  render(<VoiceInputButton onTranscript={onTranscript} />);

  await user.click(screen.getByRole("button", { name: "Start voice input" }));
  await screen.findByRole("button", { name: "Stop voice input" });
  await user.click(screen.getByRole("button", { name: "Stop voice input" }));

  await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Inspect useSessionSocket next."));
  expect(fetch).toHaveBeenCalledWith(
    "/api/transcriptions",
    expect.objectContaining({ method: "POST" })
  );
  expect(stopTrack).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Start voice input" })).toBeEnabled();
});

it("releases the microphone when the browser cannot create a recorder", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "MediaRecorder",
    class {
      constructor() {
        throw new DOMException("Unsupported recording format", "NotSupportedError");
      }
    }
  );
  render(<VoiceInputButton onTranscript={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "Start voice input" }));

  await screen.findByText("Could not start voice input.");
  expect(stopTrack).toHaveBeenCalled();
});
