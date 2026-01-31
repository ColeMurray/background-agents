# RFC 008: Voice Interface

> **Status**: Draft **Author**: Open-Inspect Team **Created**: 2025-01-31 **Related**:
> [Feature Ideas](../FEATURE_IDEAS.md)

## Summary

Add voice input capabilities to Open-Inspect, allowing users to speak commands and notes to the
agent. This enables hands-free operation, mobile-friendly interaction, and accessibility for users
who prefer voice input.

## Problem Statement

Current interaction requires keyboard input, which:

- Requires full attention and both hands
- Doesn't work well on mobile devices during commute/walk
- Excludes users who have difficulty typing
- Breaks flow when users need to describe something quickly

Voice input would allow users to:

- Review and direct sessions while doing other tasks
- Use mobile devices more effectively
- Record voice notes attached to screenshots
- Access the tool with accessibility needs

## Goals

1. **Voice commands**: Speak instructions to the agent ("click the submit button")
2. **Voice notes**: Attach audio recordings to screenshots/artifacts
3. **Transcription**: All voice input transcribed and stored as text
4. **Mobile-optimized**: Works well on phones and tablets
5. **Optional**: Voice is an additional input method, not required

## Non-Goals

- Voice output (text-to-speech for agent responses)
- Real-time voice conversation (voice input is asynchronous)
- Voice authentication
- Offline voice recognition

## Technical Design

### Voice Input Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Client (Browser)                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐ │
│  │ Microphone   │────▶│ Web Speech   │────▶│ Command      │ │
│  │ Input        │     │ API          │     │ Parser       │ │
│  └──────────────┘     └──────────────┘     └──────────────┘ │
│                              │                    │          │
│                              │ (streaming)        │          │
│                              ▼                    ▼          │
│                       ┌──────────────┐     ┌──────────────┐ │
│                       │ Transcript   │     │ Agent        │ │
│                       │ Display      │     │ Message      │ │
│                       └──────────────┘     └──────────────┘ │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ (for voice notes)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Control Plane                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐ │
│  │ Audio Blob   │────▶│ Whisper API  │────▶│ Store        │ │
│  │ Upload       │     │ Transcription│     │ Transcript   │ │
│  └──────────────┘     └──────────────┘     └──────────────┘ │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Data Model

```sql
-- Voice notes attached to sessions/artifacts
CREATE TABLE voice_notes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  artifact_id TEXT,  -- Optional: attached to specific screenshot

  -- Author
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,

  -- Audio
  audio_url TEXT NOT NULL,  -- R2 URL
  duration_ms INTEGER NOT NULL,
  mime_type TEXT NOT NULL,  -- 'audio/webm', 'audio/mp4', etc.

  -- Transcription
  transcript TEXT,
  transcript_status TEXT DEFAULT 'pending',  -- 'pending', 'processing', 'complete', 'failed'
  transcript_confidence REAL,

  -- Timestamps
  created_at INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
);

-- Index for quick lookup
CREATE INDEX idx_voice_notes_session ON voice_notes(session_id);
CREATE INDEX idx_voice_notes_artifact ON voice_notes(artifact_id);
```

### Web Speech API Integration

```typescript
interface VoiceInputManager {
  // Start/stop listening
  startListening(): void;
  stopListening(): void;
  isListening(): boolean;

  // Event handlers
  onTranscript(callback: (transcript: string, isFinal: boolean) => void): void;
  onError(callback: (error: Error) => void): void;

  // Voice note recording
  startRecording(): void;
  stopRecording(): Promise<Blob>;
  isRecording(): boolean;
}

class VoiceInputManagerImpl implements VoiceInputManager {
  private recognition: SpeechRecognition | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private transcriptCallback: ((transcript: string, isFinal: boolean) => void) | null = null;

  constructor() {
    // Check for browser support
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = "en-US";

      this.recognition.onresult = (event) => {
        const results = event.results;
        const latest = results[results.length - 1];
        const transcript = latest[0].transcript;
        const isFinal = latest.isFinal;

        this.transcriptCallback?.(transcript, isFinal);
      };
    }
  }

  startListening(): void {
    if (!this.recognition) {
      throw new Error("Speech recognition not supported");
    }
    this.recognition.start();
  }

  stopListening(): void {
    this.recognition?.stop();
  }

  async startRecording(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType: "audio/webm;codecs=opus",
    });
    this.audioChunks = [];

    this.mediaRecorder.ondataavailable = (event) => {
      this.audioChunks.push(event.data);
    };

    this.mediaRecorder.start(1000); // Collect data every second
  }

  async stopRecording(): Promise<Blob> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) {
        throw new Error("Not recording");
      }

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.audioChunks, { type: "audio/webm" });
        resolve(blob);
      };

      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach((track) => track.stop());
    });
  }

  onTranscript(callback: (transcript: string, isFinal: boolean) => void): void {
    this.transcriptCallback = callback;
  }
}
```

### Command Parser

```typescript
interface CommandParser {
  parse(transcript: string): ParsedCommand | null;
}

interface ParsedCommand {
  type: "agent_instruction" | "navigation" | "action" | "voice_note";
  content: string;
  confidence: number;
}

class SimpleCommandParser implements CommandParser {
  private navigationCommands = [
    { pattern: /^go back$/i, action: "back" },
    { pattern: /^go forward$/i, action: "forward" },
    { pattern: /^scroll (up|down)$/i, action: "scroll" },
    { pattern: /^next screenshot$/i, action: "next_screenshot" },
    { pattern: /^previous screenshot$/i, action: "previous_screenshot" },
  ];

  private actionCommands = [
    { pattern: /^take (a )?screenshot$/i, action: "screenshot" },
    { pattern: /^click (?:on )?(.+)$/i, action: "click" },
    { pattern: /^type (.+)$/i, action: "type" },
    { pattern: /^save (voice )?note$/i, action: "save_note" },
  ];

  parse(transcript: string): ParsedCommand | null {
    const cleaned = transcript.trim().toLowerCase();

    // Check navigation commands
    for (const cmd of this.navigationCommands) {
      if (cmd.pattern.test(cleaned)) {
        return {
          type: "navigation",
          content: cmd.action,
          confidence: 1.0,
        };
      }
    }

    // Check action commands
    for (const cmd of this.actionCommands) {
      const match = cleaned.match(cmd.pattern);
      if (match) {
        return {
          type: "action",
          content: `${cmd.action}:${match[1] || ""}`,
          confidence: 0.9,
        };
      }
    }

    // Default: send to agent as instruction
    return {
      type: "agent_instruction",
      content: transcript,
      confidence: 0.8,
    };
  }
}
```

### Whisper API Integration (for Voice Notes)

```typescript
interface TranscriptionService {
  transcribe(audioBlob: Blob): Promise<TranscriptionResult>;
}

interface TranscriptionResult {
  text: string;
  confidence: number;
  duration: number;
  words?: Array<{ word: string; start: number; end: number }>;
}

class WhisperTranscriptionService implements TranscriptionService {
  constructor(private apiKey: string) {}

  async transcribe(audioBlob: Blob): Promise<TranscriptionResult> {
    const formData = new FormData();
    formData.append("file", audioBlob, "audio.webm");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    const result = await response.json();

    return {
      text: result.text,
      confidence: result.segments?.[0]?.no_speech_prob
        ? 1 - result.segments[0].no_speech_prob
        : 0.9,
      duration: result.duration,
      words: result.words,
    };
  }
}
```

### API Endpoints

```typescript
// Voice notes
POST   /sessions/:sessionId/voice-notes
Body: FormData with 'audio' file
Response: { voiceNote: VoiceNote }

GET    /sessions/:sessionId/voice-notes
Response: { voiceNotes: VoiceNote[] }

GET    /sessions/:sessionId/artifacts/:artifactId/voice-notes
Response: { voiceNotes: VoiceNote[] }

DELETE /sessions/:sessionId/voice-notes/:noteId
Response: { deleted: true }

// Transcription (internal, called by upload handler)
POST   /internal/transcribe
Body: { audioUrl: string, voiceNoteId: string }
Response: { transcript: string, confidence: number }
```

### UI Components

#### Voice Input Button

```
┌─────────────────────────────────────────────────────────────┐
│  Chat Input                                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Ask or build anything...                            │   │
│  │                                                      │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌───┐  ┌───┐  ┌───┐                                       │
│  │ 🎙️ │  │ 📎 │  │ ↑ │                                       │
│  └───┘  └───┘  └───┘                                       │
│  Voice  Attach  Send                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘

When listening:
┌─────────────────────────────────────────────────────────────┐
│  Listening...                                    [Cancel]   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ "navigate to the checkout page and..."              │   │  ← Live transcript
│  │                                                      │   │
│  │  🎙️ ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │   │  ← Audio level
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Tap to stop • Say "send" to submit                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Voice Note Recording

```
┌─────────────────────────────────────────────────────────────┐
│  Recording Voice Note...                        [Cancel]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                    🔴 Recording                             │
│                                                             │
│                    ⏱️ 0:12                                  │
│                                                             │
│  ████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│                                                             │
│  Attaching to: screenshot-checkout.png                      │
│                                                             │
│                    [Stop & Save]                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Voice Note Display

```
┌─────────────────────────────────────────────────────────────┐
│  📸 screenshot-checkout.png                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                 [Screenshot Image]                   │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  🎙️ Voice Notes (2):                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ▶️ @sarah • 15 sec • 2 min ago                       │   │
│  │ "The button on the right side looks misaligned,     │   │
│  │  should check the padding values..."                │   │
│  │                                                      │   │
│  │ ▶️ @mike • 8 sec • 1 min ago                         │   │
│  │ "Agreed, also notice the shadow is missing"         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Mobile Voice Interface

```
┌─────────────────────────┐
│  Session: Checkout Test │
│         ◀ ▶             │
├─────────────────────────┤
│                         │
│  ┌───────────────────┐  │
│  │                   │  │
│  │   [Screenshot]    │  │
│  │                   │  │
│  └───────────────────┘  │
│                         │
│  Agent: I'm on the      │
│  checkout page. What    │
│  would you like me to   │
│  test?                  │
│                         │
├─────────────────────────┤
│                         │
│       ┌─────────┐       │
│       │         │       │
│       │   🎙️    │       │  ← Large touch target
│       │         │       │
│       └─────────┘       │
│    Hold to speak        │
│                         │
│  [Keyboard]  [Actions]  │
│                         │
└─────────────────────────┘
```

### Mobile Considerations

```typescript
// Detect mobile and adjust UI
function useMobileVoiceUI() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768 || "ontouchstart" in window);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  return {
    isMobile,
    // On mobile: hold-to-speak. On desktop: toggle
    voiceInputMode: isMobile ? "push-to-talk" : "toggle",
    // On mobile: larger buttons
    buttonSize: isMobile ? 64 : 40,
    // On mobile: full-screen recording overlay
    recordingOverlay: isMobile ? "fullscreen" : "inline",
  };
}
```

## Implementation Plan

### Phase 1: Basic Voice Input (Week 1-2)

- [ ] Web Speech API integration
- [ ] Voice button UI component
- [ ] Real-time transcript display
- [ ] Send voice input as text message

### Phase 2: Voice Notes (Week 3-4)

- [ ] Audio recording with MediaRecorder
- [ ] Upload to R2 storage
- [ ] Whisper API transcription
- [ ] Voice note display UI

### Phase 3: Command Recognition (Week 5-6)

- [ ] Command parser implementation
- [ ] Navigation commands
- [ ] Action commands
- [ ] Feedback on recognized commands

### Phase 4: Mobile Optimization (Week 7-8)

- [ ] Mobile-specific UI
- [ ] Push-to-talk mode
- [ ] Performance optimization
- [ ] Offline handling

### Phase 5: Polish (Week 9-10)

- [ ] Visual feedback (audio levels, recording indicator)
- [ ] Keyboard shortcuts
- [ ] Settings for voice input preferences
- [ ] Multi-language support prep

## Open Questions

1. **Language support**: Start with English only? How to handle multi-language teams?

2. **Privacy**: Voice recordings may contain sensitive info. Retention policy? Opt-out?

3. **Accuracy**: Web Speech API has variable accuracy. Require confirmation before sending?

4. **Background noise**: How to handle poor audio quality? Noise reduction?

5. **Costs**: Whisper API has per-minute costs. Limit voice note duration? Per-org quotas?

## Security Considerations

- Voice data transmitted over HTTPS only
- Audio files stored in R2 with same access controls as session
- No voice data stored locally beyond current session
- Clear indication when microphone is active
- User must explicitly grant microphone permission
- Option to disable voice features entirely

## Browser Support

| Feature        | Chrome | Firefox | Safari | Edge |
| -------------- | ------ | ------- | ------ | ---- |
| Web Speech API | ✅     | ✅\*    | ✅     | ✅   |
| MediaRecorder  | ✅     | ✅      | ✅     | ✅   |
| getUserMedia   | ✅     | ✅      | ✅     | ✅   |

\*Firefox Web Speech API has limited language support

## Accessibility Notes

- Voice input is additive, not replacement for keyboard
- Visual transcript always shown for hearing-impaired users
- Keyboard-only users can skip voice features entirely
- Voice notes have text transcripts for accessibility
