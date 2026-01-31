# RFC 009: Microsoft Teams Integration

> **Status**: Draft **Author**: Open-Inspect Team **Created**: 2025-01-31 **Related**:
> [Feature Ideas](../FEATURE_IDEAS.md)

## Summary

Deep integration with Microsoft Teams, including Teams tabs for embedded session views, Adaptive
Cards for rich notifications, meeting integration for sharing sessions, and approval workflows for
PR reviews.

## Problem Statement

Many enterprise teams use Microsoft Teams as their primary collaboration tool. Currently,
Open-Inspect only integrates with Slack. Teams users must:

- Switch context between Teams and the web app
- Manually share session links and screenshots
- Lack native notification support
- Cannot collaborate on sessions during Teams meetings

## Goals

1. **Teams Tabs**: Embed full session UI in Teams channels
2. **Adaptive Cards**: Rich, interactive notifications with screenshots
3. **Meeting integration**: Share sessions during Teams calls
4. **Bot commands**: Interact with Open-Inspect via Teams bot
5. **Approval workflows**: PR review and merge from Teams

## Non-Goals

- Feature parity with Slack integration on day 1
- Teams phone system integration
- SharePoint integration
- Teams templates/blueprints

## Technical Design

### Teams App Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Microsoft Teams                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Tab App      │  │ Bot          │  │ Meeting      │       │
│  │ (iframe)     │  │ (Messages)   │  │ Extension    │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│         │                │                   │               │
└─────────│────────────────│───────────────────│───────────────┘
          │                │                   │
          ▼                ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                Teams Backend Service                         │
│               (Cloudflare Worker)                            │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Tab Auth     │  │ Bot Handler  │  │ Meeting API  │       │
│  │ (SSO)        │  │ (Webhooks)   │  │ Integration  │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                          │                                   │
│                          ▼                                   │
│                 ┌──────────────────┐                        │
│                 │ Control Plane    │                        │
│                 │ Service Binding  │                        │
│                 └──────────────────┘                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Teams App Manifest

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "{{APP_ID}}",
  "packageName": "com.openinspect.teams",
  "developer": {
    "name": "Open-Inspect",
    "websiteUrl": "https://open-inspect.dev",
    "privacyUrl": "https://open-inspect.dev/privacy",
    "termsOfUseUrl": "https://open-inspect.dev/terms"
  },
  "name": {
    "short": "Open-Inspect",
    "full": "Open-Inspect - AI Coding Agent"
  },
  "description": {
    "short": "AI-powered coding assistant",
    "full": "Open-Inspect brings AI coding agents directly into Microsoft Teams. Create sessions, get notifications, and collaborate on code changes without leaving Teams."
  },
  "icons": {
    "color": "color.png",
    "outline": "outline.png"
  },
  "accentColor": "#3B82F6",
  "configurableTabs": [
    {
      "configurationUrl": "https://teams.open-inspect.dev/tab/config",
      "canUpdateConfiguration": true,
      "scopes": ["team", "groupchat"],
      "supportedSharePointHosts": []
    }
  ],
  "staticTabs": [
    {
      "entityId": "sessions",
      "name": "Sessions",
      "contentUrl": "https://teams.open-inspect.dev/tab/sessions",
      "websiteUrl": "https://open-inspect.dev",
      "scopes": ["personal"]
    }
  ],
  "bots": [
    {
      "botId": "{{BOT_ID}}",
      "scopes": ["personal", "team", "groupchat"],
      "commandLists": [
        {
          "scopes": ["personal", "team", "groupchat"],
          "commands": [
            {
              "title": "new",
              "description": "Create a new session"
            },
            {
              "title": "sessions",
              "description": "List recent sessions"
            },
            {
              "title": "status",
              "description": "Check session status"
            },
            {
              "title": "help",
              "description": "Show help"
            }
          ]
        }
      ],
      "supportsFiles": false
    }
  ],
  "composeExtensions": [
    {
      "botId": "{{BOT_ID}}",
      "commands": [
        {
          "id": "searchSessions",
          "type": "query",
          "title": "Search sessions",
          "description": "Search Open-Inspect sessions",
          "parameters": [
            {
              "name": "query",
              "title": "Search",
              "description": "Search by name or repo",
              "inputType": "text"
            }
          ]
        }
      ]
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": ["open-inspect.dev", "teams.open-inspect.dev"],
  "webApplicationInfo": {
    "id": "{{AAD_APP_ID}}",
    "resource": "api://teams.open-inspect.dev/{{AAD_APP_ID}}"
  }
}
```

### Tab Implementation

```typescript
// Tab configuration page
interface TabConfig {
  sessionId?: string;
  repoFilter?: string;
  view: 'session' | 'sessions-list' | 'playbooks';
}

// Tab content - embedded Open-Inspect UI
function TeamsTabContent({ context }: { context: TeamsFxContext }) {
  const [config, setConfig] = useState<TabConfig | null>(null);
  const [session, setSession] = useState<Session | null>(null);

  // Get Teams context
  useEffect(() => {
    microsoftTeams.app.getContext().then((ctx) => {
      // Authenticate using Teams SSO
      const token = await getTeamsSSOToken(ctx);
      // Exchange for Open-Inspect token
      const oiToken = await exchangeToken(token);

      // Load tab config
      const tabConfig = await getTabConfig(ctx.channel?.id);
      setConfig(tabConfig);
    });
  }, []);

  if (!config) return <Loading />;

  if (config.view === 'session' && config.sessionId) {
    return <SessionView sessionId={config.sessionId} embedded={true} />;
  }

  if (config.view === 'sessions-list') {
    return <SessionsList repoFilter={config.repoFilter} embedded={true} />;
  }

  return <PlaybooksList embedded={true} />;
}
```

### Bot Implementation

```typescript
// Teams bot handler
async function handleTeamsActivity(activity: Activity, env: Env): Promise<Response> {
  const { type, text, from, conversation } = activity;

  if (type === "message") {
    return handleMessage(activity, env);
  }

  if (type === "invoke") {
    return handleInvoke(activity, env);
  }

  return new Response("OK");
}

async function handleMessage(activity: Activity, env: Env): Promise<Response> {
  const text = activity.text?.trim() || "";
  const mention = `<at>Open-Inspect</at>`;
  const command = text.replace(mention, "").trim().toLowerCase();

  // Parse command
  if (command.startsWith("new ") || command === "new") {
    return handleNewSession(activity, command.slice(4), env);
  }

  if (command === "sessions" || command === "list") {
    return handleListSessions(activity, env);
  }

  if (command.startsWith("status ")) {
    return handleSessionStatus(activity, command.slice(7), env);
  }

  // Default: treat as prompt for active session or new investigation
  return handlePrompt(activity, command, env);
}

async function handleNewSession(activity: Activity, args: string, env: Env): Promise<Response> {
  // Parse args: "new frontend-repo" or "new owner/repo"
  const repo = parseRepoArg(args) || (await promptForRepo(activity));

  // Create session
  const session = await createSession({
    repoOwner: repo.owner,
    repoName: repo.name,
    source: "teams",
    teamsContext: {
      conversationId: activity.conversation.id,
      channelId: activity.channelData?.channel?.id,
      teamId: activity.channelData?.team?.id,
    },
  });

  // Send Adaptive Card response
  const card = createSessionCreatedCard(session);
  return sendAdaptiveCard(activity, card);
}
```

### Adaptive Cards

```typescript
// Session notification card
function createSessionNotificationCard(session: Session, event: SessionEvent): AdaptiveCard {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "Container",
        items: [
          {
            type: "TextBlock",
            text: session.name,
            weight: "Bolder",
            size: "Medium",
          },
          {
            type: "TextBlock",
            text: `${session.repoOwner}/${session.repoName}`,
            color: "Accent",
            spacing: "None",
          },
        ],
      },
      {
        type: "ColumnSet",
        columns: [
          {
            type: "Column",
            width: "auto",
            items: [
              {
                type: "Image",
                url: session.latestScreenshot?.url,
                size: "Large",
                altText: "Latest screenshot",
              },
            ],
          },
          {
            type: "Column",
            width: "stretch",
            items: [
              {
                type: "TextBlock",
                text: event.summary,
                wrap: true,
              },
              {
                type: "FactSet",
                facts: [
                  { title: "Status", value: session.status },
                  { title: "Model", value: session.model },
                  { title: "Started", value: formatTime(session.createdAt) },
                ],
              },
            ],
          },
        ],
      },
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: "View Session",
        url: `https://open-inspect.dev/sessions/${session.id}`,
      },
      {
        type: "Action.Submit",
        title: "View PR",
        data: { action: "viewPR", sessionId: session.id },
        isEnabled: !!session.prUrl,
      },
      {
        type: "Action.ShowCard",
        title: "Send Message",
        card: {
          type: "AdaptiveCard",
          body: [
            {
              type: "Input.Text",
              id: "message",
              placeholder: "Enter message for the agent...",
              isMultiline: true,
            },
          ],
          actions: [
            {
              type: "Action.Submit",
              title: "Send",
              data: { action: "sendMessage", sessionId: session.id },
            },
          ],
        },
      },
    ],
  };
}

// PR Review card
function createPRReviewCard(pr: PullRequest, session: Session): AdaptiveCard {
  return {
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "🔀 Pull Request Ready for Review",
        weight: "Bolder",
        size: "Large",
      },
      {
        type: "TextBlock",
        text: pr.title,
        weight: "Bolder",
      },
      {
        type: "TextBlock",
        text: `#${pr.number} by @${pr.author}`,
        color: "Accent",
      },
      {
        type: "Container",
        style: "emphasis",
        items: [
          {
            type: "TextBlock",
            text: "**Changes:**",
            wrap: true,
          },
          {
            type: "TextBlock",
            text: pr.summary,
            wrap: true,
          },
        ],
      },
      {
        type: "FactSet",
        facts: [
          { title: "Files changed", value: pr.changedFiles.toString() },
          { title: "Additions", value: `+${pr.additions}` },
          { title: "Deletions", value: `-${pr.deletions}` },
        ],
      },
      // Screenshot carousel
      {
        type: "ImageSet",
        imageSize: "Medium",
        images: session.screenshots.slice(0, 3).map((s) => ({
          type: "Image",
          url: s.thumbnailUrl,
        })),
      },
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: "📝 Review on GitHub",
        url: pr.url,
      },
      {
        type: "Action.Submit",
        title: "✅ Approve",
        style: "positive",
        data: { action: "approvePR", prNumber: pr.number, repo: pr.repo },
      },
      {
        type: "Action.ShowCard",
        title: "💬 Request Changes",
        card: {
          type: "AdaptiveCard",
          body: [
            {
              type: "Input.Text",
              id: "feedback",
              placeholder: "Describe the changes needed...",
              isMultiline: true,
            },
          ],
          actions: [
            {
              type: "Action.Submit",
              title: "Submit",
              data: { action: "requestChanges", prNumber: pr.number, repo: pr.repo },
            },
          ],
        },
      },
    ],
  };
}
```

### Meeting Extension

```typescript
// Meeting side panel app
interface MeetingSidePanelProps {
  meetingId: string;
  context: MeetingContext;
}

function MeetingSidePanel({ meetingId, context }: MeetingSidePanelProps) {
  const [sharedSession, setSharedSession] = useState<Session | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);

  // Load user's recent sessions
  useEffect(() => {
    loadRecentSessions().then(setSessions);
  }, []);

  const shareToMeeting = async (session: Session) => {
    // Share session to meeting stage
    await microsoftTeams.meeting.shareAppContentToStage({
      appContentUrl: `https://teams.open-inspect.dev/stage/${session.id}`
    });
    setSharedSession(session);
  };

  return (
    <div className="meeting-panel">
      <h2>Open-Inspect</h2>

      {sharedSession && (
        <div className="shared-session">
          <h3>Currently Shared</h3>
          <SessionCard session={sharedSession} compact />
          <button onClick={() => stopSharing()}>Stop Sharing</button>
        </div>
      )}

      <h3>Share a Session</h3>
      <div className="sessions-list">
        {sessions.map(session => (
          <SessionCard
            key={session.id}
            session={session}
            compact
            actions={[
              { label: 'Share', onClick: () => shareToMeeting(session) }
            ]}
          />
        ))}
      </div>
    </div>
  );
}

// Meeting stage (shared view)
function MeetingStage({ sessionId }: { sessionId: string }) {
  return (
    <div className="meeting-stage">
      <SessionView
        sessionId={sessionId}
        embedded={true}
        showParticipants={false}
        readOnly={true}  // View-only in meeting stage
      />
    </div>
  );
}
```

### Channel-to-Repo Mapping

```sql
-- Store channel mappings
CREATE TABLE teams_channel_mappings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,

  -- Mapping
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,

  -- Settings
  notify_on_completion BOOLEAN DEFAULT TRUE,
  auto_create_sessions BOOLEAN DEFAULT FALSE,
  default_playbook_id TEXT,

  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,

  UNIQUE(channel_id)
);
```

### API Endpoints

```typescript
// Teams-specific endpoints
POST   /teams/webhook           // Bot Framework webhook
POST   /teams/auth/token        // Exchange Teams token for OI token
GET    /teams/tab/config        // Get tab configuration
POST   /teams/tab/config        // Save tab configuration

// Channel mappings
GET    /teams/channels/:channelId/mapping
POST   /teams/channels/:channelId/mapping
DELETE /teams/channels/:channelId/mapping

// Meeting integration
POST   /teams/meeting/:meetingId/share
DELETE /teams/meeting/:meetingId/share
GET    /teams/meeting/:meetingId/session

// Notifications
POST   /teams/notify
Body: {
  channelId?: string;
  userId?: string;
  card: AdaptiveCard;
}
```

### Data Model

```sql
-- Teams-specific user data
CREATE TABLE teams_users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,

  -- Teams identity
  teams_user_id TEXT NOT NULL UNIQUE,
  teams_tenant_id TEXT NOT NULL,

  -- Open-Inspect identity
  oi_user_id TEXT,

  -- Preferences
  model_preference TEXT DEFAULT 'sonnet',
  notification_preferences TEXT,  -- JSON

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Conversation tracking
CREATE TABLE teams_conversations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,

  -- Context
  team_id TEXT,
  channel_id TEXT,
  conversation_type TEXT,  -- 'personal', 'channel', 'groupChat'

  -- Active session in this conversation
  active_session_id TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## Implementation Plan

### Phase 1: Bot Foundation (Week 1-2)

- [ ] Azure AD app registration
- [ ] Bot Framework integration
- [ ] Basic message handling
- [ ] Teams token exchange

### Phase 2: Adaptive Cards (Week 3-4)

- [ ] Session notification cards
- [ ] PR review cards
- [ ] Interactive card actions
- [ ] Card update (refresh) support

### Phase 3: Tab Integration (Week 5-6)

- [ ] Tab configuration page
- [ ] Embedded session view
- [ ] Teams SSO authentication
- [ ] Tab navigation

### Phase 4: Meeting Extension (Week 7-8)

- [ ] Meeting side panel
- [ ] Stage sharing
- [ ] Real-time session updates in meeting

### Phase 5: Advanced Features (Week 9-10)

- [ ] Channel-to-repo mapping
- [ ] Approval workflows
- [ ] Proactive notifications
- [ ] Admin configuration portal

## Open Questions

1. **Azure hosting**: Teams apps work best on Azure. Deploy Worker to Azure Functions, or proxy
   through existing Cloudflare setup?

2. **SSO vs separate auth**: Use Teams SSO exclusively, or support both Teams SSO and existing
   OAuth?

3. **Feature parity with Slack**: Which features to prioritize? Full parity or Teams-specific focus?

4. **Meeting integration depth**: Real-time collaboration during meetings, or just view-only
   sharing?

5. **Admin consent**: Enterprise customers need admin-consented apps. Support both personal and
   org-wide installation?

## Security Considerations

- Teams tokens must be validated with Azure AD
- Bot messages are signed - validate signatures
- Tab iframe has restricted permissions - respect CSP
- Meeting content visible to all participants - access control considerations
- Admin consent flow for enterprise deployments
- Data residency: Teams data may have geo requirements

## Compliance Notes

- Microsoft 365 Certification may be required for enterprise customers
- Privacy policy must be Teams-compliant
- Data handling must comply with Microsoft's platform policies
- Accessibility requirements (WCAG 2.1 AA minimum)
