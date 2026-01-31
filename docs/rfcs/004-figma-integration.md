# RFC 004: Figma/Design Tool Integration

> **Status**: Draft **Author**: Open-Inspect Team **Created**: 2025-01-31 **Related**:
> [Feature Ideas](../FEATURE_IDEAS.md)

## Summary

Integrate with Figma to enable visual regression testing against design source of truth. Compare
screenshots to Figma frames, detect pixel-level differences, validate design tokens, and generate
design QA reports.

## Problem Statement

Design drift is a constant challenge:

- Developers implement designs but small details get lost (spacing, colors, alignment)
- Designs evolve in Figma but implementations lag behind
- No systematic way to verify implementation matches design
- QA catches visual issues manually, inconsistently, and late

Current screenshot capabilities show what the app looks like, but not whether it matches what it
_should_ look like.

## Goals

1. **Design comparison**: Overlay implementation screenshot on Figma frame
2. **Pixel-level diff**: Highlight visual differences with configurable tolerance
3. **Design token validation**: Check colors, spacing, typography against system
4. **Automated reports**: Generate design compliance summaries
5. **Bidirectional linking**: Session artifacts link to Figma, Figma comments link to sessions

## Non-Goals

- Automated design-to-code generation
- Figma plugin development (use REST API only)
- Support for other design tools (Sketch, Adobe XD) in v1
- Component-level code generation from Figma

## Technical Design

### Figma API Integration

```typescript
interface FigmaClient {
  // Authentication
  authenticate(accessToken: string): void;

  // Get file/frame data
  getFile(fileKey: string): Promise<FigmaFile>;
  getFrame(fileKey: string, nodeId: string): Promise<FigmaNode>;

  // Export frames as images
  exportFrame(fileKey: string, nodeId: string, options: ExportOptions): Promise<Buffer>;

  // Comments
  getComments(fileKey: string): Promise<FigmaComment[]>;
  postComment(fileKey: string, message: string, position?: Position): Promise<FigmaComment>;

  // Design tokens (via Figma Variables API)
  getVariables(fileKey: string): Promise<FigmaVariables>;
}

interface ExportOptions {
  format: "png" | "jpg" | "svg" | "pdf";
  scale: number; // 1, 2, 3, 4
  contentsOnly?: boolean; // Exclude frame chrome
}
```

### Design Comparison Pipeline

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Figma     │     │  Screenshot │     │   Diff      │
│   Frame     │────▶│  Comparison │────▶│   Result    │
│   Export    │     │   Engine    │     │   Report    │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       │            ┌──────┴──────┐            │
       │            │             │            │
       ▼            ▼             ▼            ▼
   PNG/2x      Alignment      Pixel Diff    Annotated
   Export      Detection      Analysis      Image
```

### Data Model

```sql
-- Figma file connections
CREATE TABLE figma_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,

  -- Figma file info
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,

  -- Mapping to repo/feature
  repo_owner TEXT,
  repo_name TEXT,
  feature_path TEXT,  -- e.g., "/checkout", "/settings"

  -- Auth
  access_token_encrypted TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Frame-to-route mappings
CREATE TABLE figma_frame_mappings (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,

  -- Figma reference
  node_id TEXT NOT NULL,
  node_name TEXT NOT NULL,

  -- App reference
  route_pattern TEXT NOT NULL,  -- e.g., "/checkout/*", "/settings/profile"
  viewport TEXT,  -- 'desktop', 'tablet', 'mobile'
  state TEXT,  -- 'default', 'hover', 'loading', 'error', etc.

  -- Comparison settings
  tolerance REAL DEFAULT 0.01,  -- Pixel diff tolerance (0-1)
  ignore_regions TEXT,  -- JSON array of regions to ignore

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (connection_id) REFERENCES figma_connections(id)
);

-- Comparison results
CREATE TABLE design_comparisons (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  mapping_id TEXT NOT NULL,

  -- Source artifacts
  screenshot_artifact_id TEXT NOT NULL,
  figma_export_url TEXT NOT NULL,

  -- Results
  diff_score REAL NOT NULL,  -- 0-1, 0 = identical
  diff_image_url TEXT,  -- Annotated diff visualization

  -- Detailed findings
  findings TEXT,  -- JSON array of specific issues

  -- Metadata
  created_at INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (mapping_id) REFERENCES figma_frame_mappings(id)
);

-- Design token definitions (synced from Figma)
CREATE TABLE design_tokens (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,

  -- Token info
  token_type TEXT NOT NULL,  -- 'color', 'spacing', 'typography', 'shadow'
  name TEXT NOT NULL,  -- e.g., 'primary-500', 'spacing-md'
  value TEXT NOT NULL,  -- e.g., '#3B82F6', '16px'

  -- Figma reference
  figma_variable_id TEXT,

  updated_at INTEGER NOT NULL,

  FOREIGN KEY (connection_id) REFERENCES figma_connections(id)
);
```

### Comparison Algorithm

```typescript
interface ComparisonEngine {
  // Compare screenshot to Figma frame
  compare(
    screenshot: Buffer,
    figmaFrame: Buffer,
    options: ComparisonOptions
  ): Promise<ComparisonResult>;

  // Validate design tokens in screenshot
  validateTokens(
    screenshot: Buffer,
    tokens: DesignToken[],
    regions?: Region[]
  ): Promise<TokenValidationResult>;
}

interface ComparisonOptions {
  tolerance: number; // 0-1, percentage of pixels that can differ
  ignoreRegions?: Region[]; // Exclude dynamic content
  alignmentStrategy: "auto" | "manual" | "none";
  antiAliasDetection: boolean; // Ignore AA differences
  colorTolerance: number; // Delta-E threshold for color matching
}

interface ComparisonResult {
  score: number; // 0-1, 0 = perfect match
  diffImage: Buffer; // Visualization of differences
  findings: Finding[];
  metadata: {
    screenshotSize: { width: number; height: number };
    figmaSize: { width: number; height: number };
    alignmentOffset?: { x: number; y: number };
    totalPixels: number;
    differentPixels: number;
  };
}

interface Finding {
  type: "color" | "spacing" | "alignment" | "missing" | "extra" | "typography";
  severity: "error" | "warning" | "info";
  description: string;
  region: Region;
  expected?: string;
  actual?: string;
  figmaReference?: string; // Link to Figma node
}
```

### Image Diff Implementation

Using pixelmatch or similar library:

```typescript
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

async function compareImages(
  img1Buffer: Buffer,
  img2Buffer: Buffer,
  options: ComparisonOptions
): Promise<{ diffScore: number; diffImage: Buffer }> {
  const img1 = PNG.sync.read(img1Buffer);
  const img2 = PNG.sync.read(img2Buffer);

  // Resize to match dimensions (use larger as reference)
  const width = Math.max(img1.width, img2.width);
  const height = Math.max(img1.height, img2.height);

  const diff = new PNG({ width, height });

  const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, {
    threshold: options.colorTolerance,
    includeAA: !options.antiAliasDetection,
    diffColor: [255, 0, 0], // Red for differences
    diffColorAlt: [0, 255, 0], // Green for anti-aliased
  });

  const totalPixels = width * height;
  const diffScore = numDiffPixels / totalPixels;

  return {
    diffScore,
    diffImage: PNG.sync.write(diff),
  };
}
```

### Design Token Extraction

```typescript
async function extractColorsFromImage(screenshot: Buffer): Promise<ColorSample[]> {
  // Use color quantization to find dominant colors
  // Compare against design token colors
  // Return matches and mismatches
}

async function validateSpacing(
  screenshot: Buffer,
  expectedSpacing: SpacingToken[]
): Promise<SpacingValidation[]> {
  // Use edge detection to find element boundaries
  // Measure distances between elements
  // Compare to spacing tokens
}

async function validateTypography(
  screenshot: Buffer,
  expectedFonts: TypographyToken[]
): Promise<TypographyValidation[]> {
  // OCR to detect text regions
  // Estimate font size, weight, line height
  // Compare to typography tokens
}
```

### API Endpoints

```typescript
// Figma connection management
POST   /figma/connections
Body: { fileKey: string; accessToken: string; repoOwner?: string; repoName?: string }
Response: { connection: FigmaConnection }

GET    /figma/connections
Response: { connections: FigmaConnection[] }

DELETE /figma/connections/:id

// Frame mappings
GET    /figma/connections/:id/frames
Response: { frames: FigmaNode[] }  // From Figma API

POST   /figma/connections/:id/mappings
Body: { nodeId: string; routePattern: string; viewport?: string; state?: string }
Response: { mapping: FigmaFrameMapping }

GET    /figma/mappings
Query: { route?: string }  // Find mapping for a route
Response: { mappings: FigmaFrameMapping[] }

// Comparisons
POST   /sessions/:id/compare
Body: {
  screenshotArtifactId: string;
  mappingId?: string;  // Auto-detect if not provided
}
Response: { comparison: DesignComparison }

GET    /sessions/:id/comparisons
Response: { comparisons: DesignComparison[] }

// Design tokens
GET    /figma/connections/:id/tokens
Response: { tokens: DesignToken[] }

POST   /figma/connections/:id/tokens/sync
Response: { synced: number; tokens: DesignToken[] }

// Figma comments
POST   /figma/connections/:id/comment
Body: {
  nodeId: string;
  message: string;
  sessionId?: string;  // Link to session
  artifactId?: string;  // Link to screenshot
}
Response: { comment: FigmaComment }
```

### UI Components

#### Figma Connection Setup

```
┌─────────────────────────────────────────────────────────────┐
│  Connect Figma File                                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Figma File URL:                                            │
│  [https://figma.com/file/abc123/Design-System        ]     │
│                                                             │
│  Access Token: [••••••••••••••••••••••••           ]       │
│  ℹ️ Generate at figma.com/developers/api                    │
│                                                             │
│  Link to Repository (optional):                             │
│  [myorg/frontend ▼]                                         │
│                                                             │
│  [Cancel]                              [Connect]            │
└─────────────────────────────────────────────────────────────┘
```

#### Frame Mapping Interface

```
┌─────────────────────────────────────────────────────────────┐
│  Map Figma Frames to Routes                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Figma File: Design System v2                              │
│                                                             │
│  ┌────────────────────┬────────────────────────────────┐   │
│  │ Figma Frame        │ Route Mapping                  │   │
│  ├────────────────────┼────────────────────────────────┤   │
│  │ 📱 Checkout/Desktop│ /checkout/* (desktop)          │   │
│  │ 📱 Checkout/Mobile │ /checkout/* (mobile)           │   │
│  │ 📱 Settings/Profile│ /settings/profile              │   │
│  │ 📱 Login           │ /login                         │   │
│  │ ○ Dashboard        │ [Add mapping...]               │   │
│  │ ○ Payments         │ [Add mapping...]               │   │
│  └────────────────────┴────────────────────────────────┘   │
│                                                             │
│  [Import All Frames]              [Save Mappings]          │
└─────────────────────────────────────────────────────────────┘
```

#### Comparison View

```
┌─────────────────────────────────────────────────────────────┐
│  Design Comparison                              98.2% Match │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  View: [Screenshot] [Figma] [Overlay ●] [Diff]             │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                      │   │
│  │     ┌──────────────────────────────────────────┐    │   │
│  │     │                                          │    │   │
│  │     │    [Overlay view showing both images     │    │   │
│  │     │     with slider to reveal differences]   │    │   │
│  │     │                                          │    │   │
│  │     │    ←───────────●───────────→            │    │   │
│  │     │                                          │    │   │
│  │     └──────────────────────────────────────────┘    │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Findings (3):                                              │
│  ⚠️ Button color #3B82F5 differs from design #3B82F6       │
│  ⚠️ Spacing between cards is 12px, design shows 16px       │
│  ℹ️ Font weight appears lighter than design spec            │
│                                                             │
│  [Comment in Figma]  [Create Issue]  [Mark as Acceptable]   │
└─────────────────────────────────────────────────────────────┘
```

#### Design QA Report

```
┌─────────────────────────────────────────────────────────────┐
│  Design QA Report - Session "Checkout Audit"                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Overall Compliance: 94%                                    │
│  ████████████████████████████████████░░░░                  │
│                                                             │
│  Pages Checked: 8    Findings: 12    Critical: 2           │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Page              │ Score │ Issues                  │   │
│  ├───────────────────┼───────┼─────────────────────────┤   │
│  │ /checkout         │  98%  │ 1 spacing              │   │
│  │ /checkout/payment │  96%  │ 2 color                │   │
│  │ /checkout/confirm │  89%  │ 3 spacing, 1 alignment │   │
│  │ /checkout/success │ 100%  │ -                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Token Compliance:                                          │
│  Colors     ████████████████████░░░░  92%                  │
│  Spacing    ██████████████░░░░░░░░░░  78%                  │
│  Typography ████████████████████████  100%                 │
│                                                             │
│  [Export PDF]  [Share Report]  [View All Findings]          │
└─────────────────────────────────────────────────────────────┘
```

### Agent Integration

New tool for the agent:

```typescript
const compareTofigmaTool = {
  name: "compare_to_figma",
  description: "Compare current screenshot to Figma design and report differences",
  parameters: {
    screenshotArtifactId: { type: "string", description: "The screenshot to compare" },
    figmaMappingId: {
      type: "string",
      optional: true,
      description: "Specific Figma frame to compare against",
    },
  },
  handler: async ({ screenshotArtifactId, figmaMappingId }) => {
    // Auto-detect mapping from current URL if not provided
    // Run comparison
    // Return structured findings
  },
};
```

Agent can use this naturally:

```
User: Check if this page matches the design
Agent: I'll take a screenshot and compare it to the Figma design.
       [take_screenshot] → screenshot-123.png
       [compare_to_figma] →

       The page is 96% matching the Figma design. I found 2 issues:
       1. The primary button color is #3B82F5 but should be #3B82F6
       2. The card spacing is 12px instead of the 16px in the design

       Would you like me to create issues for these, or should I try to fix them?
```

## Implementation Plan

### Phase 1: Figma Connection (Week 1-2)

- [ ] Figma OAuth or access token storage
- [ ] File/frame fetching
- [ ] Basic connection management UI

### Phase 2: Frame Mapping (Week 3-4)

- [ ] Mapping data model
- [ ] Mapping UI with frame browser
- [ ] Route pattern matching logic

### Phase 3: Comparison Engine (Week 5-6)

- [ ] Image diff algorithm integration
- [ ] Alignment detection
- [ ] Diff visualization generation

### Phase 4: Agent Integration (Week 7-8)

- [ ] `compare_to_figma` tool
- [ ] Comparison results in session artifacts
- [ ] Findings display in UI

### Phase 5: Tokens & Reports (Week 9-10)

- [ ] Design token sync from Figma Variables
- [ ] Token validation in comparisons
- [ ] Design QA report generation

## Open Questions

1. **Figma auth model**: OAuth (user-level) vs access tokens (team-level)? OAuth is more secure but
   complex.

2. **Comparison tolerance**: What's the right default? Different tolerances for different element
   types?

3. **Dynamic content**: How to handle timestamps, avatars, user-generated content in comparisons?

4. **Frame versions**: Figma files change - should we version-lock comparisons? Track design drift
   over time?

5. **Performance**: Figma API rate limits? Caching strategy for frame exports?

## Security Considerations

- Figma access tokens grant broad file access - encrypt at rest
- Comparison images may contain sensitive UI - same access controls as screenshots
- Consider read-only Figma scope where possible
- Token refresh/rotation policies
