# Open-Inspect Web Client

Next.js web application for interacting with Open-Inspect coding sessions.

## Features

- GitHub and optional Google authentication through the control plane
- Session dashboard with list view
- Real-time streaming via WebSocket
- Message timeline with tool calls
- Multi-participant presence indicators
- Responsive design for desktop and mobile

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Next.js App                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                       App Router                          │   │
│  │  /                  - Dashboard (session list)           │   │
│  │  /session/new       - Create new session                 │   │
│  │  /session/[id]      - Session view with streaming        │   │
│  │  /settings          - Settings (secrets management)      │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      API Routes                           │   │
│  │  /api/auth/[...auth]     - Signed auth proxy             │   │
│  │  /api/sessions           - Session CRUD                  │   │
│  │  /api/repos              - Repository list               │   │
│  │  /api/repos/:owner/:name/secrets - Secrets CRUD          │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                        Hooks                              │   │
│  │  useSessionSocket - WebSocket connection + state         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
      Control Plane API              Control Plane WebSocket
```

## Setup

### Prerequisites

- Node.js 22+
- A deployed control plane with at least one sign-in provider
- GitHub App repository credentials configured on the control plane

### Sign-In and GitHub App Setup

The control plane owns sign-in providers and repository credentials. A GitHub App installation is
required for repository access even when Google is the only sign-in provider. To enable GitHub
sign-in with that App:

1. Go to GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
2. Set the **Callback URL** to: `https://your-domain.com/api/auth/callback/github`
3. Under **"Where can this GitHub App be installed?"**, select **"Any account"**

> **Important**: If you select "Only on this account", only users from that account will be able to
> authenticate. Other users will experience a redirect loop when trying to sign in.

> **Note for Organizations**: If your GitHub App is owned by an organization, the "Any account"
> setting should allow users outside the organization to authenticate, but this has not been
> extensively tested. Please verify this works for your use case.

Always-required repository permission for the GitHub App:

- **Repository permissions**: Contents (read & write) - for repo operations

When GitHub sign-in uses email/domain admission, also grant **Account permissions: Email addresses
(read-only)**.

### Environment Variables

Create `.env.local`:

```bash
# Control Plane
CONTROL_PLANE_URL=http://localhost:8787
NEXT_PUBLIC_WS_URL=ws://localhost:8787
SERVICE_AUTH_SECRET=your_web_service_sig1_secret
```

The web app is a framework-free BFF. It signs requests with `SERVICE_AUTH_SECRET`, forwards only
Better Auth's opaque session cookie, and does not hold OAuth provider credentials or admission
policy. Configure those on the control plane through Terraform; `/login` resolves the enabled
provider set from that authority at request time.

### Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Type check
npm run typecheck

# Build for production
npm run build
```

## Pages

### Dashboard (`/`)

- Lists all user's sessions
- Shows session status, repository, and creation date
- Link to create new session

### New Session (`/session/new`)

- Repository selector (populated from GitHub)
- Optional title field
- Creates session and redirects to session view

### Settings (`/settings`)

- Repository-scoped secrets management
- Select a repository, then add/edit/delete environment variable secrets
- Secrets are encrypted and stored in D1, injected into sandboxes at runtime

### Session View (`/session/[id]`)

- Real-time WebSocket connection
- Message input with typing indicator
- Event timeline (tool calls, results, tokens)
- Streaming content display
- Participant presence list
- Stop button during execution
- Artifacts sidebar (PRs, screenshots)

## WebSocket Protocol

The `useSessionSocket` hook manages:

1. **Connection**: Auto-connect with exponential backoff on disconnect
2. **Subscription**: Authenticates and subscribes to session
3. **Events**: Handles sandbox events (tokens, tool calls, etc.)
4. **Presence**: Tracks active participants
5. **Health**: Ping/pong every 30 seconds

## Styling

Uses Tailwind CSS with:

- Dark mode support via `prefers-color-scheme`
- Custom color variables
- Responsive design utilities

## State Management

Uses React state + hooks for simplicity. For larger apps, consider:

- Zustand for global state
- React Query for server state
- Jotai for atoms
