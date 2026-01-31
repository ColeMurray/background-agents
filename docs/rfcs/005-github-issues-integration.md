# RFC 005: GitHub Issues as Session Triggers

> **Status**: Draft **Author**: Open-Inspect Team **Created**: 2025-01-31 **Related**:
> [Feature Ideas](../FEATURE_IDEAS.md), [Linear Integration](../LINEAR_INTEGRATION_PLAN.md)

## Summary

Deep GitHub integration that allows creating sessions directly from issues, posting session findings
back to issues, and creating a closed loop between issue tracking and investigation sessions.

## Problem Statement

The current workflow for investigating a GitHub issue:

1. Read issue in GitHub
2. Switch to Open-Inspect
3. Create session, manually re-type or paste issue context
4. Investigate, find results
5. Switch back to GitHub
6. Manually summarize findings in a comment
7. Create PR (separately linked)

This is friction-heavy and loses context at each handoff. Developers often skip steps 5-6, leaving
issues without investigation documentation.

## Goals

1. **One-click investigation**: "Investigate with Open-Inspect" button on GitHub issues
2. **Context injection**: Session automatically has full issue context (title, body, comments,
   labels)
3. **Auto-commenting**: Findings posted back to issue with screenshots
4. **Bidirectional linking**: Issue → Session, Session → Issue, PR → Issue
5. **`/inspect` command**: Trigger investigation from issue comments

## Non-Goals

- Fully automated triage (human initiates investigation)
- GitHub Projects integration (focus on Issues)
- GitHub Discussions support
- Replacing GitHub's native features

## Technical Design

### GitHub App Enhancements

Current GitHub App permissions need expansion:

```yaml
# Current permissions
permissions:
  contents: write      # For commits/PRs
  pull_requests: write # For creating PRs

# Additional permissions needed
permissions:
  issues: write        # Comment on issues, read issue data
  metadata: read       # Repo metadata
```

### Issue Context Injection

When creating a session from an issue:

```typescript
interface IssueContext {
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  assignees: string[];
  comments: Array<{
    author: string;
    body: string;
    createdAt: string;
  }>;
  linkedPRs: Array<{
    number: number;
    title: string;
    state: string;
  }>;
  referencedIssues: number[];
  milestone?: string;
  createdAt: string;
  updatedAt: string;
}

async function createSessionFromIssue(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  userId: string
): Promise<Session> {
  // Fetch full issue context from GitHub API
  const issueContext = await github.getIssueContext(repoOwner, repoName, issueNumber);

  // Create session with context
  const session = await createSession({
    repoOwner,
    repoName,
    name: `Investigate: ${issueContext.title}`,
    linkedIssue: {
      number: issueNumber,
      url: `https://github.com/${repoOwner}/${repoName}/issues/${issueNumber}`,
    },
    initialContext: issueContext,
  });

  // Post comment on issue linking to session
  await github.createIssueComment(
    repoOwner,
    repoName,
    issueNumber,
    `🔍 Investigation started in [Open-Inspect Session](${session.url})\n\n` +
      `Investigating by @${userId}`
  );

  return session;
}
```

### System Prompt Augmentation

When session is linked to an issue:

```
## GitHub Issue Context

You are investigating GitHub Issue #${issueNumber}: "${title}"

**Issue Description:**
${body}

**Labels:** ${labels.join(', ')}
**Reported by:** @${author} on ${createdAt}

**Recent Comments:**
${comments.map(c => `@${c.author}: ${c.body}`).join('\n\n')}

${linkedPRs.length > 0 ? `**Related PRs:** ${linkedPRs.map(pr => `#${pr.number}`).join(', ')}` : ''}

---

Your goal is to investigate this issue, reproduce it if possible, identify the root cause,
and either fix it or document your findings. When you find something significant, it will
be posted back to the GitHub issue.
```

### Auto-Comment Pipeline

Post findings back to the issue automatically:

```typescript
interface FindingComment {
  type: "reproduction" | "root_cause" | "fix_proposed" | "unable_to_reproduce" | "needs_info";
  summary: string;
  details?: string;
  screenshots?: string[]; // Artifact IDs
  codeReferences?: Array<{ file: string; line: number; snippet: string }>;
}

async function postFindingToIssue(
  sessionId: string,
  issueNumber: number,
  finding: FindingComment
): Promise<void> {
  const session = await getSession(sessionId);

  // Format comment with markdown
  let comment = `## ${getEmojiForType(finding.type)} ${getTitleForType(finding.type)}\n\n`;
  comment += finding.summary + "\n\n";

  if (finding.details) {
    comment += `<details><summary>Details</summary>\n\n${finding.details}\n\n</details>\n\n`;
  }

  if (finding.screenshots?.length) {
    comment += "### Screenshots\n\n";
    for (const artifactId of finding.screenshots) {
      const artifact = await getArtifact(artifactId);
      comment += `![${artifact.name}](${artifact.url})\n\n`;
    }
  }

  if (finding.codeReferences?.length) {
    comment += "### Code References\n\n";
    for (const ref of finding.codeReferences) {
      comment += `**${ref.file}:${ref.line}**\n\`\`\`\n${ref.snippet}\n\`\`\`\n\n`;
    }
  }

  comment += `---\n*From [Open-Inspect Session](${session.url})*`;

  await github.createIssueComment(session.repoOwner, session.repoName, issueNumber, comment);
}
```

### `/inspect` Webhook Command

Allow triggering investigation from issue comments:

```typescript
// GitHub webhook handler for issue_comment events
async function handleIssueComment(event: IssueCommentEvent): Promise<void> {
  const { comment, issue, repository } = event;

  // Check for /inspect command
  const inspectMatch = comment.body.match(/^\/inspect(?:\s+(.*))?$/m);
  if (!inspectMatch) return;

  const additionalContext = inspectMatch[1]?.trim();

  // Create session
  const session = await createSessionFromIssue(
    repository.owner.login,
    repository.name,
    issue.number,
    comment.user.login
  );

  // If additional context provided, send as first prompt
  if (additionalContext) {
    await sendPrompt(session.id, {
      content: additionalContext,
      authorId: comment.user.login,
      source: "github",
    });
  }

  // React to comment to acknowledge
  await github.addReaction(comment.id, "rocket");
}
```

### Data Model Changes

```sql
-- Add issue linking to sessions
ALTER TABLE sessions ADD COLUMN linked_issue_number INTEGER;
ALTER TABLE sessions ADD COLUMN linked_issue_url TEXT;

-- Track issue-related events
CREATE TABLE issue_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  event_type TEXT NOT NULL,  -- 'session_started', 'finding_posted', 'pr_linked'
  github_comment_id TEXT,  -- If we posted a comment
  payload TEXT,  -- JSON details
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Index for looking up sessions by issue
CREATE INDEX idx_sessions_linked_issue ON sessions(repo_owner, repo_name, linked_issue_number);
```

### API Endpoints

```typescript
// Create session from issue
POST /sessions/from-issue
Body: {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  additionalContext?: string;
}
Response: { session: Session }

// Get issue context for a session
GET /sessions/:id/issue
Response: { issue: IssueContext }

// Post finding to linked issue
POST /sessions/:id/issue/comment
Body: {
  type: 'reproduction' | 'root_cause' | 'fix_proposed' | 'unable_to_reproduce' | 'needs_info';
  summary: string;
  details?: string;
  screenshotArtifactIds?: string[];
}
Response: { commentUrl: string }

// Link existing session to issue
POST /sessions/:id/issue/link
Body: { issueNumber: number }
Response: { linked: true }

// Unlink session from issue
DELETE /sessions/:id/issue/link
Response: { unlinked: true }

// Webhook endpoint for GitHub
POST /webhooks/github
Headers: { 'X-Hub-Signature-256': string }
Body: GitHubWebhookPayload
```

### GitHub App Manifest Update

```json
{
  "name": "Open-Inspect",
  "url": "https://open-inspect.dev",
  "hook_attributes": {
    "url": "https://api.open-inspect.dev/webhooks/github"
  },
  "redirect_url": "https://open-inspect.dev/auth/github/callback",
  "callback_urls": ["https://open-inspect.dev/auth/github/callback"],
  "setup_url": "https://open-inspect.dev/setup",
  "public": true,
  "default_permissions": {
    "contents": "write",
    "pull_requests": "write",
    "issues": "write",
    "metadata": "read"
  },
  "default_events": ["issue_comment", "issues", "pull_request"]
}
```

### UI Components

#### Issue Context Panel (in Session)

```
┌─────────────────────────────────────────────────────────────┐
│  Linked Issue                                      [Unlink] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  #234: Button doesn't work on mobile                        │
│  🏷️ bug, mobile, priority:high                             │
│  👤 @sarah • 📅 2 days ago                                  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ The submit button on the checkout page doesn't      │   │
│  │ respond to taps on iOS Safari. Works fine on...     │   │
│  │ [Read more]                                         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  💬 3 comments • 🔗 1 linked PR                            │
│                                                             │
│  [View on GitHub]  [Post Finding]                          │
└─────────────────────────────────────────────────────────────┘
```

#### Post Finding Dialog

```
┌─────────────────────────────────────────────────────────────┐
│  Post Finding to Issue #234                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Finding Type:                                              │
│  ○ 🔄 Reproduced the issue                                 │
│  ● 🎯 Found root cause                                     │
│  ○ 🔧 Proposed fix                                         │
│  ○ ❓ Unable to reproduce                                  │
│  ○ 📝 Need more information                                │
│                                                             │
│  Summary: *                                                 │
│  [The issue is caused by a missing touchstart event    ]   │
│  [handler on the button component. iOS Safari requires ]   │
│  [explicit touch events for reliable tap detection.    ]   │
│                                                             │
│  Include screenshots:                                       │
│  ☑ screenshot-mobile-view.png                              │
│  ☑ screenshot-console-error.png                            │
│  ☐ screenshot-desktop-works.png                            │
│                                                             │
│  [Preview Comment]                     [Post to GitHub]     │
└─────────────────────────────────────────────────────────────┘
```

#### GitHub Issue (with Open-Inspect Integration)

The issue page in GitHub would show:

````markdown
## Button doesn't work on mobile

**@sarah** opened this issue 2 days ago • 3 comments

The submit button on the checkout page doesn't respond to taps on iOS Safari...

---

**@open-inspect-bot** commented 1 hour ago

🔍 Investigation started in [Open-Inspect Session](https://open-inspect.dev/sessions/abc123)

Investigating by @mike

---

**@open-inspect-bot** commented 30 minutes ago

## 🎯 Found Root Cause

The issue is caused by a missing touchstart event handler on the button component. iOS Safari
requires explicit touch events for reliable tap detection.

### Screenshots

![Mobile view showing the button](https://r2.open-inspect.dev/screenshot-mobile.png)

### Code References

**src/components/Button.tsx:45**

```tsx
// Missing: onTouchStart handler
<button onClick={handleClick}>Submit</button>
```
````

---

_From [Open-Inspect Session](https://open-inspect.dev/sessions/abc123)_

````

### Agent Tools

New tools for GitHub issue interaction:

```typescript
const postToIssueTool = {
  name: 'post_to_issue',
  description: 'Post a finding or update to the linked GitHub issue',
  parameters: {
    type: {
      type: 'string',
      enum: ['reproduction', 'root_cause', 'fix_proposed', 'unable_to_reproduce', 'needs_info'],
      description: 'Type of finding'
    },
    summary: { type: 'string', description: 'Brief summary of finding' },
    details: { type: 'string', optional: true, description: 'Detailed explanation' },
    includeRecentScreenshots: { type: 'boolean', optional: true, default: false }
  }
};

const getIssueCommentsTool = {
  name: 'get_issue_comments',
  description: 'Fetch recent comments from the linked GitHub issue',
  parameters: {
    limit: { type: 'number', optional: true, default: 10 }
  }
};
````

Example agent flow:

```
User: Investigate this issue
Agent: I see this session is linked to GitHub Issue #234: "Button doesn't work on mobile"
       Let me read the issue details and try to reproduce the problem.

       [navigates to checkout page, takes screenshot]

       I can see the button. Let me check on mobile viewport.

       [resizes to mobile, attempts click, takes screenshot]

       I've reproduced the issue. The button doesn't respond on mobile.
       Let me check the console for errors.

       [opens devtools, finds touch event error]

       Found it! The issue is a missing touch event handler.

       [post_to_issue type="root_cause" summary="Missing touchstart handler..."]

       I've posted my findings to the GitHub issue. Would you like me to
       create a fix?
```

## Implementation Plan

### Phase 1: Issue Context (Week 1-2)

- [ ] GitHub App permission updates
- [ ] Issue fetching API
- [ ] Context injection in system prompt
- [ ] `POST /sessions/from-issue` endpoint

### Phase 2: Auto-Commenting (Week 3-4)

- [ ] Comment formatting logic
- [ ] Screenshot embedding in comments
- [ ] `post_to_issue` agent tool
- [ ] Post finding UI

### Phase 3: Webhook Integration (Week 5-6)

- [ ] GitHub webhook handler
- [ ] `/inspect` command parsing
- [ ] Webhook signature verification
- [ ] Event logging

### Phase 4: UI Polish (Week 7-8)

- [ ] Issue context panel in session
- [ ] Post finding dialog
- [ ] Issue linking management
- [ ] Activity feed showing GitHub interactions

## Open Questions

1. **Rate limiting**: GitHub API has rate limits - how to handle high-volume investigation?

2. **Comment frequency**: How often should we auto-post to issues? Every finding? Only significant
   ones?

3. **Comment editing**: Should we update existing comments or always create new ones?

4. **Multiple investigators**: What if two people start investigating the same issue?

5. **Issue state management**: Should we auto-close issues when a fix is merged? Too aggressive?

## Security Considerations

- Webhook signature verification is critical
- Issue content may contain sensitive info (credentials in bug reports)
- Comments posted should not reveal internal tooling details
- Rate limiting to prevent abuse of `/inspect` command
- Permission checks: can this user actually see this issue?
