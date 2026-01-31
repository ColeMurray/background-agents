# RFC 003: Cross-Session Memory & Context

> **Status**: Draft **Author**: Open-Inspect Team **Created**: 2025-01-31 **Related**:
> [Feature Ideas](../FEATURE_IDEAS.md)

## Summary

Enable the agent to learn from and reference past sessions, creating organizational memory that
accumulates over time. Sessions can discover similar past issues, inherit context from related work,
and build on institutional knowledge.

## Problem Statement

Currently, each session starts with a blank slate. The agent has no knowledge of:

- Similar bugs found and fixed in past sessions
- Common patterns and workarounds for this codebase
- What other team members have already investigated
- Historical context about features and their quirks

This leads to:

- Repeated investigation of known issues
- Lost institutional knowledge when people leave
- No learning curve - the agent doesn't get "better" at your codebase over time
- Missed connections between related issues

## Goals

1. **Semantic search**: Find relevant past sessions by natural language query
2. **Automatic linking**: Surface similar sessions without explicit search
3. **Context inheritance**: "Continue from Session X" with full context
4. **Knowledge extraction**: Distill sessions into reusable knowledge nuggets
5. **Organizational memory**: Shared knowledge base across all team sessions

## Non-Goals

- Full conversation history in every session (context limits)
- Replacing documentation (this augments, not replaces)
- Cross-organization learning (privacy boundaries)
- Real-time RAG during agent execution (latency concerns)

## Technical Design

### Knowledge Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Knowledge Base                            │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ Session         │  │ Knowledge       │  │ Entity      │ │
│  │ Embeddings      │  │ Nuggets         │  │ Index       │ │
│  │                 │  │                 │  │             │ │
│  │ - Summary       │  │ - Bug patterns  │  │ - Files     │ │
│  │ - Key findings  │  │ - Workarounds   │  │ - Features  │ │
│  │ - Screenshots   │  │ - Code patterns │  │ - Components│ │
│  │ - Tool calls    │  │ - Gotchas       │  │ - APIs      │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
│           │                   │                   │         │
│           └───────────────────┴───────────────────┘         │
│                              │                              │
│                    Vector Database                          │
│                    (Similarity Search)                      │
└─────────────────────────────────────────────────────────────┘
```

### Data Model

```sql
-- Session summaries for search
CREATE TABLE session_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,

  -- Generated summary content
  title TEXT NOT NULL,
  summary TEXT NOT NULL,  -- 2-3 paragraph summary
  key_findings TEXT,  -- JSON array of bullet points
  files_touched TEXT,  -- JSON array of file paths
  features_involved TEXT,  -- JSON array of feature names
  bugs_found TEXT,  -- JSON array of bug descriptions
  resolution TEXT,  -- How the session concluded

  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Vector embeddings for similarity search
CREATE TABLE session_embeddings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  org_id TEXT NOT NULL,

  -- Different embedding types
  embedding_type TEXT NOT NULL,  -- 'summary', 'finding', 'screenshot_description'
  content_hash TEXT NOT NULL,  -- For deduplication
  embedding BLOB NOT NULL,  -- Vector (e.g., 1536 dims for text-embedding-3-small)

  -- Source reference
  source_text TEXT,  -- Original text that was embedded
  source_artifact_id TEXT,  -- If from screenshot/artifact

  created_at INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Knowledge nuggets extracted from sessions
CREATE TABLE knowledge_nuggets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,

  -- Content
  type TEXT NOT NULL,  -- 'bug_pattern', 'workaround', 'gotcha', 'best_practice'
  title TEXT NOT NULL,
  content TEXT NOT NULL,

  -- Provenance
  source_session_ids TEXT NOT NULL,  -- JSON array of sessions this came from
  confidence REAL DEFAULT 1.0,  -- How reliable this knowledge is

  -- Relevance
  related_files TEXT,  -- JSON array of file patterns
  related_features TEXT,  -- JSON array of features
  tags TEXT,  -- JSON array of tags

  -- Lifecycle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER DEFAULT 0,

  -- Manual curation
  is_verified BOOLEAN DEFAULT FALSE,
  verified_by TEXT,
  is_deprecated BOOLEAN DEFAULT FALSE,
  deprecation_reason TEXT
);

-- Session relationships
CREATE TABLE session_relations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,

  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,  -- 'similar', 'continues', 'related', 'supersedes'

  -- How the relation was established
  created_by TEXT NOT NULL,  -- 'auto' or user_id
  confidence REAL,  -- For auto-detected relations
  notes TEXT,

  created_at INTEGER NOT NULL,

  FOREIGN KEY (source_session_id) REFERENCES sessions(id),
  FOREIGN KEY (target_session_id) REFERENCES sessions(id)
);
```

### Embedding Pipeline

```typescript
interface EmbeddingPipeline {
  // Generate embeddings for a completed session
  processSession(sessionId: string): Promise<void>;

  // Search for similar sessions
  searchSessions(query: string, options: SearchOptions): Promise<SessionSearchResult[]>;

  // Find similar sessions to a given session
  findSimilarSessions(sessionId: string, limit?: number): Promise<SessionSearchResult[]>;

  // Extract knowledge nuggets from session
  extractKnowledge(sessionId: string): Promise<KnowledgeNugget[]>;
}

interface SearchOptions {
  orgId: string;
  repoFilter?: string[]; // Filter to specific repos
  dateRange?: { start: number; end: number };
  minSimilarity?: number; // 0-1, default 0.7
  limit?: number; // default 10
  includeResolved?: boolean; // Include sessions that found resolutions
}

interface SessionSearchResult {
  sessionId: string;
  title: string;
  summary: string;
  similarity: number;
  keyFindings: string[];
  createdAt: number;
  resolution?: string;
}
```

### Session Summary Generation

When a session completes (or periodically for long sessions):

```typescript
async function generateSessionSummary(sessionId: string): Promise<SessionSummary> {
  // Gather session data
  const messages = await getSessionMessages(sessionId);
  const toolCalls = await getSessionToolCalls(sessionId);
  const artifacts = await getSessionArtifacts(sessionId);
  const screenshots = artifacts.filter((a) => a.type === "screenshot");

  // Generate structured summary using Claude
  const summary = await claude.generate({
    model: "claude-3-haiku", // Fast and cheap for summarization
    system: `You are summarizing a coding/QA session. Extract:
      - A concise title (max 60 chars)
      - A 2-3 paragraph summary of what happened
      - Key findings (bullet points)
      - Files that were examined or modified
      - Features/areas of the app involved
      - Any bugs discovered
      - How the session concluded (resolution)`,
    messages: [
      { role: "user", content: formatSessionForSummary(messages, toolCalls, screenshots) },
    ],
  });

  return parseSummaryResponse(summary);
}
```

### Knowledge Extraction

Distill sessions into reusable nuggets:

```typescript
async function extractKnowledgeNuggets(sessionId: string): Promise<KnowledgeNugget[]> {
  const summary = await getSessionSummary(sessionId);
  const messages = await getSessionMessages(sessionId);

  const extraction = await claude.generate({
    model: "claude-3-5-sonnet", // Better reasoning for knowledge extraction
    system: `Extract reusable knowledge from this session. Look for:

      1. Bug patterns: Recurring issues that might happen again
         Example: "The payments form doesn't validate negative amounts"

      2. Workarounds: Solutions to tricky problems
         Example: "To test the email flow, use mailhog at localhost:8025"

      3. Gotchas: Non-obvious behaviors that cause confusion
         Example: "The cache must be cleared after changing feature flags"

      4. Best practices: Good patterns worth repeating
         Example: "Always screenshot before and after data mutations"

      Return structured JSON with nuggets.`,
    messages: [{ role: "user", content: formatForExtraction(summary, messages) }],
  });

  return parseNuggets(extraction);
}
```

### Context Injection

When starting a new session, inject relevant context:

```typescript
async function getSessionContext(
  orgId: string,
  repo: string,
  initialPrompt: string
): Promise<SessionContext> {
  // Search for relevant past sessions
  const similarSessions = await embeddingPipeline.searchSessions(initialPrompt, {
    orgId,
    repoFilter: [repo],
    limit: 5,
    minSimilarity: 0.75,
  });

  // Get relevant knowledge nuggets
  const nuggets = await getRelevantNuggets(orgId, repo, initialPrompt);

  // Format for system prompt
  return {
    relatedSessions: similarSessions.map((s) => ({
      title: s.title,
      summary: s.summary,
      keyFindings: s.keyFindings,
      sessionId: s.sessionId, // For linking
    })),
    knowledge: nuggets.map((n) => ({
      type: n.type,
      content: n.content,
      source: `From session ${n.sourceSessionIds[0]}`,
    })),
  };
}
```

### System Prompt Augmentation

```
[Standard system prompt...]

## Relevant Context from Past Sessions

### Similar Past Sessions
1. **"Fix payment form validation"** (3 days ago)
   - Found that negative amounts weren't being validated
   - Fixed in PaymentForm.tsx lines 45-60
   - Related PR: #234

2. **"Investigate checkout timeout"** (1 week ago)
   - Issue was slow database query in OrderService
   - Added index on orders.user_id
   - Performance improved 10x

### Known Issues & Workarounds
- **Gotcha**: The test environment uses a different Stripe key - always check STRIPE_ENV
- **Workaround**: To reset test data, call POST /api/test/reset with admin token
- **Bug pattern**: File uploads over 5MB fail silently - check for this

If any of these past sessions are directly relevant, you can reference them.
To see full details of a past session, ask to "show session [id]".
```

### API Endpoints

```typescript
// Search across sessions
GET /search/sessions
Query: {
  q: string;  // Natural language query
  repo?: string;
  limit?: number;
}
Response: { results: SessionSearchResult[] }

// Get similar sessions
GET /sessions/:id/similar
Response: { similar: SessionSearchResult[] }

// Link sessions manually
POST /sessions/:id/relations
Body: { targetSessionId: string; relationType: string; notes?: string }

// Get session context for new session
GET /sessions/context
Query: { repo: string; prompt: string }
Response: { relatedSessions: [...]; knowledge: [...] }

// Knowledge nuggets
GET /knowledge
Query: { repo?: string; type?: string; search?: string }
Response: { nuggets: KnowledgeNugget[] }

POST /knowledge
Body: { type, title, content, relatedFiles?, relatedFeatures?, tags? }
Response: { nugget: KnowledgeNugget }

PUT /knowledge/:id
Body: { content?, isVerified?, isDeprecated?, deprecationReason? }

DELETE /knowledge/:id

// Continue from session
POST /sessions
Body: {
  ...normalSessionFields,
  continueFromSessionId?: string;  // Inherits context
}
```

### UI Components

#### Related Sessions Panel

```
┌─────────────────────────────────────────────────────────────┐
│  Related Sessions                                    [View All] │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 🔗 Fix payment form validation          93% similar │   │
│  │    Found negative amount bug • 3 days ago • PR #234 │   │
│  │    [View Session] [Apply Learnings]                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 🔗 Investigate checkout timeout         78% similar │   │
│  │    Database query optimization • 1 week ago         │   │
│  │    [View Session]                                   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  💡 "This looks similar to the bug in Session #234..."     │
│     [Dismiss] [Show me the connection]                      │
└─────────────────────────────────────────────────────────────┘
```

#### Knowledge Base Browser

```
┌─────────────────────────────────────────────────────────────┐
│  Knowledge Base                              [+ Add Nugget] │
├─────────────────────────────────────────────────────────────┤
│  🔍 [Search knowledge...                              ]     │
│                                                             │
│  Filter: [All Types ▼] [All Repos ▼] [All Tags ▼]          │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 🐛 Bug Pattern                            Verified ✓ │   │
│  │ Payment form doesn't validate negative amounts       │   │
│  │                                                      │   │
│  │ Related: PaymentForm.tsx, checkout flow             │   │
│  │ From: Session "Fix payment validation" (3 days ago)  │   │
│  │ Used: 4 times                                        │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 💡 Workaround                                        │   │
│  │ Reset test data: POST /api/test/reset with admin     │   │
│  │                                                      │   │
│  │ Related: testing, data management                    │   │
│  │ From: Multiple sessions                              │   │
│  │ Used: 12 times                                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ⚠️ Gotcha                                 Deprecated │   │
│  │ Old Stripe key issue (fixed in PR #456)              │   │
│  │ ...                                                  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

#### Continue Session Dialog

```
┌─────────────────────────────────────────────────────────────┐
│  Continue from Session                                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Base session:                                              │
│  "Fix payment form validation" by sarah@ (3 days ago)       │
│                                                             │
│  What will be inherited:                                    │
│  ✓ Full conversation context                               │
│  ✓ Key findings and screenshots                            │
│  ✓ Knowledge of files examined                             │
│  ○ Sandbox state (requires fork - see RFC-001)             │
│                                                             │
│  Your starting prompt:                                      │
│  [I want to add more validation cases...              ]     │
│                                                             │
│  [Cancel]                              [Start Session]      │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Summary Generation (Week 1-2)

- [ ] Session summary generation on completion
- [ ] Summary storage and retrieval
- [ ] Basic summary display in session list

### Phase 2: Embedding Infrastructure (Week 3-4)

- [ ] Vector database setup (pgvector or Pinecone)
- [ ] Embedding generation pipeline
- [ ] Basic similarity search API

### Phase 3: Context Injection (Week 5-6)

- [ ] Related sessions panel in UI
- [ ] System prompt augmentation
- [ ] "Continue from session" feature

### Phase 4: Knowledge Base (Week 7-8)

- [ ] Knowledge nugget extraction
- [ ] Knowledge base UI
- [ ] Manual curation tools
- [ ] Verification workflow

### Phase 5: Polish & Analytics (Week 9-10)

- [ ] Search quality tuning
- [ ] Usage analytics
- [ ] Knowledge effectiveness tracking
- [ ] Deprecation workflow

## Open Questions

1. **Vector database choice**: pgvector (simpler, in Postgres) vs Pinecone (managed, faster at
   scale)?

2. **Embedding model**: OpenAI text-embedding-3-small vs Claude embeddings vs open source?

3. **Privacy boundaries**: Can knowledge cross repo boundaries within an org? What about forks?

4. **Context limits**: How much related context can we inject before overwhelming the agent?

5. **Knowledge curation**: Who can verify/deprecate nuggets? Review workflow needed?

6. **Staleness**: How do we handle knowledge that becomes outdated as code changes?

## Security Considerations

- Session summaries may contain sensitive info - same access controls as sessions
- Knowledge nuggets are org-scoped by default
- Embeddings are org-isolated in vector DB
- Search results filtered by user's accessible repos
- Consider PII scrubbing in summaries
