# RFC 007: Annotation Layer on Screenshots

> **Status**: Draft **Author**: Open-Inspect Team **Created**: 2025-01-31 **Related**:
> [Feature Ideas](../FEATURE_IDEAS.md)

## Summary

Add a collaborative annotation layer to screenshots that allows users to draw, highlight, and
comment on specific areas. Annotations are persistent, visible to all session participants, and can
be converted into issues for tracking.

## Problem Statement

Screenshots capture what the agent sees, but users often want to:

- Point out specific areas: "Look at this button" or "This alignment is off"
- Discuss visual details with team members
- Mark issues for follow-up
- Provide context that's tied to exact visual locations

Currently, users must describe visual issues in text, which is imprecise and loses the spatial
context.

## Goals

1. **Drawing tools**: Boxes, circles, arrows, freehand drawing, text labels
2. **Positional comments**: Click anywhere on screenshot to add a comment
3. **Collaborative**: All participants see annotations in real-time
4. **Persistent**: Annotations saved and visible on session replay
5. **Actionable**: Convert annotations to Linear/GitHub issues with one click
6. **Lightweight**: Fast rendering, doesn't slow down session view

## Non-Goals

- Advanced image editing (crop, resize, filters)
- Annotation templates or stamps
- OCR or auto-detection of UI elements
- Annotation on video/streaming views (screenshots only)

## Technical Design

### Data Model

```sql
-- Annotations table
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,  -- The screenshot being annotated

  -- Author
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,

  -- Position (relative to image, 0-1 range for portability)
  x REAL NOT NULL,  -- 0.0 = left edge, 1.0 = right edge
  y REAL NOT NULL,  -- 0.0 = top edge, 1.0 = bottom edge

  -- Annotation type and content
  type TEXT NOT NULL,  -- 'comment', 'drawing', 'label'
  content TEXT,  -- For comments: the text. For drawings: JSON shape data

  -- Visual style
  color TEXT DEFAULT '#FF0000',

  -- Status
  status TEXT DEFAULT 'open',  -- 'open', 'resolved', 'wont_fix'
  resolved_by TEXT,
  resolved_at INTEGER,

  -- Linked issues
  linked_issue_url TEXT,
  linked_issue_id TEXT,

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
);

-- Annotation replies (threaded discussion)
CREATE TABLE annotation_replies (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL,

  -- Author
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,

  -- Content
  content TEXT NOT NULL,

  -- Timestamps
  created_at INTEGER NOT NULL,

  FOREIGN KEY (annotation_id) REFERENCES annotations(id)
);

-- Index for fetching annotations per artifact
CREATE INDEX idx_annotations_artifact ON annotations(artifact_id);
CREATE INDEX idx_annotations_session ON annotations(session_id);
```

### Drawing Data Structures

```typescript
// Base annotation types
type AnnotationType = "comment" | "box" | "circle" | "arrow" | "freehand" | "text";

interface BaseAnnotation {
  id: string;
  sessionId: string;
  artifactId: string;
  authorId: string;
  authorName: string;
  type: AnnotationType;
  color: string;
  status: "open" | "resolved" | "wont_fix";
  linkedIssue?: { url: string; id: string; provider: "github" | "linear" };
  createdAt: number;
  updatedAt: number;
  replies: AnnotationReply[];
}

// Position-only annotation (comment pin)
interface CommentAnnotation extends BaseAnnotation {
  type: "comment";
  x: number; // 0-1 relative
  y: number; // 0-1 relative
  content: string;
}

// Box/rectangle annotation
interface BoxAnnotation extends BaseAnnotation {
  type: "box";
  x: number; // Top-left X (0-1)
  y: number; // Top-left Y (0-1)
  width: number; // 0-1 relative
  height: number; // 0-1 relative
  content?: string; // Optional label
}

// Circle/ellipse annotation
interface CircleAnnotation extends BaseAnnotation {
  type: "circle";
  cx: number; // Center X (0-1)
  cy: number; // Center Y (0-1)
  rx: number; // Radius X (0-1)
  ry: number; // Radius Y (0-1)
  content?: string;
}

// Arrow annotation
interface ArrowAnnotation extends BaseAnnotation {
  type: "arrow";
  x1: number; // Start X
  y1: number; // Start Y
  x2: number; // End X (arrowhead)
  y2: number; // End Y (arrowhead)
  content?: string; // Label at midpoint
}

// Freehand drawing
interface FreehandAnnotation extends BaseAnnotation {
  type: "freehand";
  points: Array<{ x: number; y: number }>; // Path points (0-1)
  strokeWidth: number;
}

// Text label
interface TextAnnotation extends BaseAnnotation {
  type: "text";
  x: number;
  y: number;
  content: string;
  fontSize: number; // In relative units
}

type Annotation =
  | CommentAnnotation
  | BoxAnnotation
  | CircleAnnotation
  | ArrowAnnotation
  | FreehandAnnotation
  | TextAnnotation;
```

### Real-Time Sync

Annotations sync via WebSocket like other session events:

```typescript
// New event types
interface AnnotationCreatedEvent {
  type: "annotation_created";
  annotation: Annotation;
}

interface AnnotationUpdatedEvent {
  type: "annotation_updated";
  annotationId: string;
  changes: Partial<Annotation>;
}

interface AnnotationDeletedEvent {
  type: "annotation_deleted";
  annotationId: string;
}

interface AnnotationReplyEvent {
  type: "annotation_reply";
  annotationId: string;
  reply: AnnotationReply;
}

// Broadcast to all session participants
async function broadcastAnnotationEvent(sessionId: string, event: AnnotationEvent): Promise<void> {
  const session = await getSessionDO(sessionId);
  await session.broadcast(event);
}
```

### API Endpoints

```typescript
// Annotation CRUD
POST   /sessions/:sessionId/artifacts/:artifactId/annotations
Body: { type, x, y, content?, color?, ... }  // Depends on type
Response: { annotation: Annotation }

GET    /sessions/:sessionId/artifacts/:artifactId/annotations
Response: { annotations: Annotation[] }

GET    /sessions/:sessionId/annotations  // All annotations in session
Response: { annotations: Annotation[] }

PUT    /sessions/:sessionId/annotations/:annotationId
Body: { content?, color?, status?, ... }
Response: { annotation: Annotation }

DELETE /sessions/:sessionId/annotations/:annotationId
Response: { deleted: true }

// Replies
POST   /sessions/:sessionId/annotations/:annotationId/replies
Body: { content: string }
Response: { reply: AnnotationReply }

// Issue linking
POST   /sessions/:sessionId/annotations/:annotationId/create-issue
Body: {
  provider: 'github' | 'linear';
  title?: string;  // Auto-generated from annotation if not provided
  includeScreenshot: boolean;
}
Response: { issueUrl: string, issueId: string }

POST   /sessions/:sessionId/annotations/:annotationId/link-issue
Body: { issueUrl: string }
Response: { linked: true }

// Batch operations
POST   /sessions/:sessionId/annotations/resolve-all
Body: { artifactId?: string }  // Optional filter
Response: { resolved: number }

POST   /sessions/:sessionId/annotations/export
Body: { format: 'png' | 'pdf'; artifactIds?: string[] }
Response: { exportUrl: string }
```

### UI Components

#### Annotation Mode Toolbar

```
┌─────────────────────────────────────────────────────────────┐
│  📸 Screenshot: checkout-page.png              [Annotate ●] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Toolbar (when annotating):                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 💬  ▢  ○  →  ✏️  T │ 🔴 🟢 🔵 🟡 │ ↩️ Done      │   │
│  │ Cmnt Box Cir Arw Draw Txt   Colors    Undo          │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                      │   │
│  │     ┌─────────────────────┐                         │   │
│  │     │   ┌──────────┐      │ ← Red box annotation   │   │
│  │     │   │  Submit  │      │                         │   │
│  │     │   └──────────┘      │   💬 "Button looks     │   │
│  │     │              ↑      │      off-center"       │   │
│  │     │        ─────────────┤   └─ @sarah, 2m ago   │   │
│  │     └─────────────────────┘                         │   │
│  │                                                      │   │
│  │            ○ ← Circle highlighting form field       │   │
│  │           ╱╲                                        │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Comment Thread Panel

```
┌─────────────────────────────────────────────────────────────┐
│  Annotations (3)                          [Show All | Mine] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 🔴 Button alignment issue                    Open   │   │
│  │ by @sarah • 5 minutes ago                           │   │
│  │                                                      │   │
│  │ "The submit button looks 2-3px off center. Compare  │   │
│  │  to the design."                                    │   │
│  │                                                      │   │
│  │ 💬 @mike: "I see it too. Might be padding issue"   │   │
│  │ 💬 @sarah: "Let me check the CSS"                   │   │
│  │                                                      │   │
│  │ [Reply]  [Create Issue]  [Resolve ✓]               │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 🟢 Form field styling                      Resolved │   │
│  │ by @mike • 1 hour ago • Linked: #234               │   │
│  │                                                      │   │
│  │ "Input border should be darker per design system"   │   │
│  │                                                      │   │
│  │ ✓ Resolved by @sarah                                │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### Create Issue Dialog

```
┌─────────────────────────────────────────────────────────────┐
│  Create Issue from Annotation                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Create in: ○ GitHub  ● Linear                             │
│                                                             │
│  Title:                                                     │
│  [Button alignment issue on checkout page              ]    │
│                                                             │
│  Description: (auto-generated, editable)                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ## Issue                                             │   │
│  │ The submit button appears off-center by 2-3px.      │   │
│  │                                                      │   │
│  │ ## Screenshot                                        │   │
│  │ [Annotated screenshot will be attached]             │   │
│  │                                                      │   │
│  │ ## Session                                           │   │
│  │ From: [Session Link]                                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ☑ Include annotated screenshot                            │
│  ☑ Link issue back to annotation                           │
│                                                             │
│  [Cancel]                              [Create Issue]       │
└─────────────────────────────────────────────────────────────┘
```

### Canvas Rendering

```typescript
// React component for annotation canvas
interface AnnotationCanvasProps {
  imageUrl: string;
  annotations: Annotation[];
  mode: 'view' | 'annotate';
  selectedTool?: AnnotationType;
  selectedColor?: string;
  onAnnotationCreate: (annotation: Omit<Annotation, 'id'>) => void;
  onAnnotationUpdate: (id: string, changes: Partial<Annotation>) => void;
  onAnnotationSelect: (annotation: Annotation | null) => void;
}

function AnnotationCanvas({
  imageUrl,
  annotations,
  mode,
  selectedTool,
  selectedColor,
  onAnnotationCreate,
  onAnnotationUpdate,
  onAnnotationSelect
}: AnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [drawing, setDrawing] = useState<Partial<Annotation> | null>(null);

  // Load image and set up canvas
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setImageSize({ width: img.width, height: img.height });
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // Convert pixel coords to relative (0-1)
  const toRelative = (px: number, dimension: number) => px / dimension;
  const toPixels = (rel: number, dimension: number) => rel * dimension;

  // Render annotations
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    // Clear and redraw image
    ctx.clearRect(0, 0, imageSize.width, imageSize.height);

    // Draw each annotation
    for (const annotation of annotations) {
      renderAnnotation(ctx, annotation, imageSize);
    }

    // Draw in-progress drawing
    if (drawing) {
      renderAnnotation(ctx, drawing as Annotation, imageSize, true);
    }
  }, [annotations, drawing, imageSize]);

  // Handle mouse events for drawing
  const handleMouseDown = (e: React.MouseEvent) => {
    if (mode !== 'annotate' || !selectedTool) return;

    const rect = canvasRef.current!.getBoundingClientRect();
    const x = toRelative(e.clientX - rect.left, imageSize.width);
    const y = toRelative(e.clientY - rect.top, imageSize.height);

    // Start new annotation based on tool
    setDrawing(createAnnotationStart(selectedTool, x, y, selectedColor));
  };

  // ... mouse move, mouse up handlers

  return (
    <div className="annotation-canvas-container">
      <img src={imageUrl} alt="Screenshot" style={{ display: 'none' }} />
      <canvas
        ref={canvasRef}
        width={imageSize.width}
        height={imageSize.height}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{ cursor: mode === 'annotate' ? 'crosshair' : 'default' }}
      />
      {/* Render comment pins as DOM elements for easier interaction */}
      {annotations.filter(a => a.type === 'comment').map(a => (
        <CommentPin
          key={a.id}
          annotation={a as CommentAnnotation}
          imageSize={imageSize}
          onClick={() => onAnnotationSelect(a)}
        />
      ))}
    </div>
  );
}
```

### Export with Annotations

```typescript
async function exportAnnotatedScreenshot(
  artifactId: string,
  annotations: Annotation[],
  format: "png" | "pdf"
): Promise<string> {
  // Load original image
  const originalImage = await loadImage(artifact.url);

  // Create canvas with annotations
  const canvas = document.createElement("canvas");
  canvas.width = originalImage.width;
  canvas.height = originalImage.height;
  const ctx = canvas.getContext("2d")!;

  // Draw original image
  ctx.drawImage(originalImage, 0, 0);

  // Draw all annotations
  for (const annotation of annotations) {
    renderAnnotation(ctx, annotation, { width: canvas.width, height: canvas.height });
  }

  // Export
  if (format === "png") {
    const blob = await canvasToBlob(canvas, "image/png");
    return uploadToR2(blob);
  } else {
    // PDF export with multiple pages if needed
    return generatePdfWithAnnotations(canvas, annotations);
  }
}
```

## Implementation Plan

### Phase 1: Core Annotation (Week 1-2)

- [ ] Data model and API endpoints
- [ ] Basic canvas rendering
- [ ] Box and circle drawing tools
- [ ] Comment pins

### Phase 2: Drawing Tools (Week 3-4)

- [ ] Arrow tool
- [ ] Freehand drawing
- [ ] Text labels
- [ ] Color picker
- [ ] Undo/redo

### Phase 3: Collaboration (Week 5-6)

- [ ] Real-time sync via WebSocket
- [ ] Reply threads
- [ ] Resolve/reopen workflow
- [ ] User attribution

### Phase 4: Issue Integration (Week 7-8)

- [ ] Create GitHub issue from annotation
- [ ] Create Linear issue from annotation
- [ ] Bidirectional linking
- [ ] Annotated screenshot attachment

### Phase 5: Polish (Week 9-10)

- [ ] Export functionality
- [ ] Keyboard shortcuts
- [ ] Touch support (tablet)
- [ ] Performance optimization

## Open Questions

1. **Annotation on zoomed view**: When user zooms screenshot, do annotations scale? Stay fixed?

2. **Annotation on resized images**: Relative positioning (0-1) handles this, but what about very
   different aspect ratios?

3. **Annotation conflicts**: Two users drawing at same spot simultaneously - how to handle?

4. **Annotation cleanup**: Should resolved annotations auto-hide after some time?

5. **Mobile/touch**: How well do drawing tools work on mobile devices?

## Security Considerations

- Annotation content could contain sensitive info - same access controls as session
- Issue creation requires user's GitHub/Linear auth, not session service account
- Rate limiting on annotation creation to prevent spam
- XSS prevention in annotation text content
