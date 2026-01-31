# RFC 001: Session Replay & Time Travel

> **Status**: Draft **Author**: Open-Inspect Team **Created**: 2025-01-31 **Related**:
> [Feature Ideas](../FEATURE_IDEAS.md)

## Summary

Add the ability to replay sessions like a video, scrub through the timeline of screenshots and
actions, fork sessions from any point, and compare session runs side-by-side.

## Problem Statement

Currently, sessions are append-only streams. Once a session progresses, there's no way to:

- Review what happened at a specific moment in time
- Jump back to a previous state and try a different approach
- Compare two different attempts at solving the same problem
- Generate shareable recordings for bug reports or demos

Users doing QA testing often want to say "go back to when you were on the settings page" or "try
that again but click the other button." Today this requires starting a new session and manually
navigating back.

## Goals

1. **Timeline navigation**: Scrub through session history like a video player
2. **Fork from any point**: Create a new session starting from a specific moment
3. **Side-by-side comparison**: View two session runs in parallel
4. **Export capabilities**: Generate GIFs/videos from session screenshots
5. **Maintain performance**: Don't significantly slow down active sessions

## Non-Goals

- Real-time video recording of the sandbox (too expensive)
- Sub-second precision (screenshot-level granularity is sufficient)
- Undo/redo of agent actions (fork is the mechanism for "trying again")

## Technical Design

### Data Model Changes

```sql
-- Add timing metadata to existing events table
ALTER TABLE events ADD COLUMN timestamp_ms INTEGER;
ALTER TABLE events ADD COLUMN duration_ms INTEGER;

-- New table for session snapshots (for forking)
CREATE TABLE session_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,  -- The event this snapshot was taken after
  modal_snapshot_id TEXT,  -- Modal filesystem snapshot ID
  git_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT,  -- JSON: branch, uncommitted changes, etc.
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- New table for session relationships
CREATE TABLE session_forks (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  forked_from_event_id TEXT NOT NULL,
  forked_at INTEGER NOT NULL,
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id),
  FOREIGN KEY (child_session_id) REFERENCES sessions(id)
);
```

### Snapshot Strategy

Taking Modal snapshots after every action would be prohibitively expensive. Instead:

1. **Automatic snapshots**: Take snapshots at key moments:
   - After git operations (commit, checkout, pull)
   - After file writes that pass linting
   - Every N minutes of activity (configurable, default 5 min)
   - When user explicitly requests ("checkpoint here")

2. **On-demand snapshots**: When user wants to fork from a point without a snapshot:
   - Replay git operations from nearest snapshot
   - Re-apply file changes from event log
   - This is slower but handles arbitrary fork points

3. **Snapshot retention**: Keep snapshots for 7 days by default, allow pinning

### Timeline Data Structure

```typescript
interface TimelineFrame {
  eventId: string;
  timestamp: number;
  type: "screenshot" | "tool_call" | "tool_result" | "message" | "git_sync";

  // For screenshots
  screenshotUrl?: string;
  thumbnailUrl?: string;

  // For tool calls
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  durationMs?: number;

  // For messages
  messageContent?: string;
  authorId?: string;

  // Snapshot availability
  hasSnapshot: boolean;
  nearestSnapshotEventId?: string;
}

interface SessionTimeline {
  sessionId: string;
  frames: TimelineFrame[];
  totalDurationMs: number;
  snapshotCount: number;
}
```

### API Changes

```typescript
// Get session timeline for replay
GET /sessions/:id/timeline
Response: SessionTimeline

// Get specific frame details
GET /sessions/:id/timeline/frames/:eventId
Response: TimelineFrame & { fullDetails: true }

// Fork session from a point
POST /sessions/:id/fork
Body: {
  fromEventId: string;
  name?: string;  // Name for the new session
}
Response: {
  sessionId: string;  // New session ID
  status: 'ready' | 'restoring';  // 'restoring' if snapshot rebuild needed
  estimatedReadyMs?: number;
}

// Create manual snapshot
POST /sessions/:id/snapshots
Body: { eventId?: string }  // Defaults to current state
Response: { snapshotId: string }

// Compare two sessions
GET /sessions/compare
Query: { sessionA: string, sessionB: string }
Response: {
  sessionA: SessionTimeline;
  sessionB: SessionTimeline;
  commonAncestor?: { sessionId: string, eventId: string };
  divergencePoint?: { eventIdA: string, eventIdB: string };
}

// Export session as video/GIF
POST /sessions/:id/export
Body: {
  format: 'gif' | 'mp4' | 'webm';
  startEventId?: string;
  endEventId?: string;
  speed?: number;  // 1x, 2x, etc.
  includeToolCalls?: boolean;
}
Response: { exportId: string, status: 'processing' }

GET /sessions/:id/exports/:exportId
Response: { status: 'processing' | 'ready' | 'failed', url?: string }
```

### UI Components

#### Timeline Player

```
┌─────────────────────────────────────────────────────────────────┐
│  ◀ ▐▐  ▶  │ 0:00:00 ──●────────────────────────────── 0:15:32 │
├─────────────────────────────────────────────────────────────────┤
│  📸  📸  🔧  📸  🔧🔧🔧  📸  💬  📸  📸  🔧  📸             │
│  ▲                                                              │
│  Current frame                                                  │
└─────────────────────────────────────────────────────────────────┘
│ ● Snapshots available (can fork instantly)                      │
│ ○ No snapshot (fork requires rebuild)                           │
```

- Scrubber bar with frame markers
- Play/pause/speed controls
- Frame type indicators (screenshot, tool call, message)
- Snapshot availability indicators
- Keyboard shortcuts: J/K for frame-by-frame, L for play, Space for pause

#### Fork Dialog

```
┌─────────────────────────────────────────────────────────┐
│  Fork Session                                           │
├─────────────────────────────────────────────────────────┤
│  Fork from: "Clicked submit button" (2 min ago)         │
│                                                         │
│  ● Snapshot available - instant fork                    │
│  ○ No snapshot - rebuild required (~30 sec)             │
│                                                         │
│  New session name: [Trip editing - attempt 2    ]       │
│                                                         │
│  [Cancel]                              [Fork Session]   │
└─────────────────────────────────────────────────────────┘
```

#### Comparison View

```
┌──────────────────────────┬──────────────────────────┐
│  Session A               │  Session B               │
│  Trip editing v1         │  Trip editing v2         │
├──────────────────────────┼──────────────────────────┤
│  ┌────────────────────┐  │  ┌────────────────────┐  │
│  │   Screenshot A     │  │  │   Screenshot B     │  │
│  │                    │  │  │                    │  │
│  └────────────────────┘  │  └────────────────────┘  │
│                          │                          │
│  🔧 Clicked "Edit"       │  🔧 Clicked "Settings"   │ ← Divergence
│                          │                          │
├──────────────────────────┴──────────────────────────┤
│  ◀ ▐▐  ▶  │ ──────────●────────────────────────── │
│           │ Sync playback  [×]  Link timelines    │
└─────────────────────────────────────────────────────┘
```

### Video Export Pipeline

1. User requests export with parameters
2. Control plane queues export job
3. Worker fetches all screenshots in range
4. FFmpeg (in Modal) stitches frames with:
   - Configurable frame duration
   - Optional tool call overlays
   - Timestamp watermark
5. Upload to R2, return URL
6. URL expires after 24 hours

```python
# Modal function for video generation
@app.function(image=ffmpeg_image, timeout=300)
def generate_session_video(
    screenshot_urls: list[str],
    frame_durations: list[int],
    format: str,
    include_overlays: bool
) -> bytes:
    # Download screenshots
    # Generate FFmpeg filter complex for timing
    # Add overlays if requested
    # Encode and return
```

## Implementation Plan

### Phase 1: Timeline Infrastructure (Week 1-2)

- [ ] Add timestamp_ms to events table
- [ ] Create timeline API endpoint
- [ ] Build basic timeline UI component
- [ ] Add frame-by-frame navigation

### Phase 2: Snapshot System (Week 3-4)

- [ ] Integrate Modal snapshot API
- [ ] Implement automatic snapshot triggers
- [ ] Create snapshot management UI
- [ ] Add snapshot retention policies

### Phase 3: Fork Capability (Week 5-6)

- [ ] Fork API endpoint
- [ ] Snapshot restoration logic
- [ ] Git state replay for non-snapshot forks
- [ ] Fork dialog UI
- [ ] Session relationship tracking

### Phase 4: Comparison & Export (Week 7-8)

- [ ] Comparison API and UI
- [ ] FFmpeg integration in Modal
- [ ] Export queue system
- [ ] GIF/video generation
- [ ] Download/share UI

## Open Questions

1. **Snapshot costs**: Modal snapshots have storage costs. What's the right balance between snapshot
   frequency and cost?

2. **Fork permissions**: Can any participant fork, or only the session owner?

3. **Forked session billing**: If original session owner is different from fork creator, who "owns"
   the forked session?

4. **Comparison scope**: Should comparison work across repos, or only within the same repo?

5. **Export watermarking**: Should exports include Open-Inspect branding? User configurable?

## Security Considerations

- Snapshots may contain sensitive data (env vars, tokens) - apply same access controls as session
- Export URLs should be signed and time-limited
- Fork inherits parent session's participant list by default

## Alternatives Considered

1. **Full video recording**: Record actual screen video instead of screenshots. Rejected due to
   storage costs and complexity.

2. **Event sourcing replay**: Replay all commands to recreate state. Rejected because tool calls may
   not be deterministic (network requests, time-dependent logic).

3. **Browser-only replay**: Store DOM snapshots and replay in browser. Rejected because we need full
   sandbox state, not just browser state.
