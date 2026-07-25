"use client";

import { useEffect, useRef, useState } from "react";
import { MicrophoneIcon, StopIcon } from "@/components/ui/icons";

type VoiceInputButtonProps = {
  onTranscript: (text: string) => void;
  disabled?: boolean;
};

type VoiceInputStatus = "idle" | "recording" | "transcribing";

export function VoiceInputButton({ onTranscript, disabled = false }: VoiceInputButtonProps) {
  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(
    () => () => {
      stopStream(streamRef.current);
    },
    []
  );

  const startRecording = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice input is not supported by this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopStream(streamRef.current);
        streamRef.current = null;
        void transcribeRecording(
          new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" })
        );
      };
      recorder.onerror = () => {
        recorder.onstop = null;
        stopStream(streamRef.current);
        streamRef.current = null;
        recorderRef.current = null;
        setError("Voice recording failed.");
        setStatus("idle");
      };
      recorder.start();
      setStatus("recording");
    } catch (recordingError) {
      setError(
        recordingError instanceof DOMException && recordingError.name === "NotAllowedError"
          ? "Microphone access was denied."
          : "Could not start voice input."
      );
      stopStream(streamRef.current);
      streamRef.current = null;
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === "recording") {
      setStatus("transcribing");
      recorderRef.current.stop();
    }
  };

  const transcribeRecording = async (audio: Blob) => {
    if (audio.size === 0) {
      recorderRef.current = null;
      chunksRef.current = [];
      setError("No audio was recorded.");
      setStatus("idle");
      return;
    }

    try {
      const body = new FormData();
      body.set("audio", audio, recordingFilename(audio.type));
      const response = await fetch("/api/transcriptions", { method: "POST", body });
      const data: unknown = await response.json();
      if (!response.ok || !isTranscriptionResponse(data)) {
        throw new Error(isErrorResponse(data) ? data.error : "Failed to transcribe recording");
      }
      onTranscript(data.text);
    } catch (transcriptionError) {
      setError(
        transcriptionError instanceof Error
          ? transcriptionError.message
          : "Failed to transcribe recording"
      );
    } finally {
      recorderRef.current = null;
      chunksRef.current = [];
      setStatus("idle");
    }
  };

  const isRecording = status === "recording";
  const label = isRecording ? "Stop voice input" : "Start voice input";

  return (
    <>
      {error && (
        <span role="status" className="max-w-48 text-right text-xs text-destructive">
          {error}
        </span>
      )}
      {status === "transcribing" && (
        <span className="text-xs text-muted-foreground">Transcribing...</span>
      )}
      <button
        type="button"
        onClick={isRecording ? stopRecording : startRecording}
        disabled={disabled || status === "transcribing"}
        className={`p-2 transition disabled:cursor-not-allowed disabled:opacity-30 ${
          isRecording
            ? "bg-destructive-muted text-destructive"
            : "text-secondary-foreground hover:text-foreground"
        }`}
        title={label}
        aria-label={label}
      >
        {isRecording ? <StopIcon className="h-5 w-5" /> : <MicrophoneIcon className="h-5 w-5" />}
      </button>
    </>
  );
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function recordingFilename(mimeType: string) {
  if (mimeType.includes("mp4")) return "prompt.mp4";
  if (mimeType.includes("ogg")) return "prompt.ogg";
  return "prompt.webm";
}

function isTranscriptionResponse(value: unknown): value is { text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function isErrorResponse(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}
