# Multi-Tenant Architecture Plan

**Goal:** Convert Open-Inspect from a single-tenant system (shared credentials) to a secure
multi-tenant system where users can only access repositories they are authorized for via GitHub.

## 1. Architecture Overview

### Current State (Single-Tenant)

- **Global Config:** Relies on a single `GITHUB_APP_INSTALLATION_ID` environment variable.
- **Access:** Any user with access to the UI can access _all_ repositories the GitHub App is
  installed on.
- **Git Operations:** Sandboxes use a broad installation token that has access to all App-installed
  repositories.

### Target State (Multi-Tenant)

- **Dynamic Discovery:** The system dynamically discovers which GitHub App installations the
  logged-in user has access to.
- **Strict Scoping (User Context):**
  - **Repo Listing:** Repository lists are fetched using the **User's OAuth Token** (via
    `GET /user/installations/{id}/repositories`). This ensures users only see repositories they
    personally have access to, preventing leaks of restricted repos within an organization that the
    App might technically have access to.
- **Strict Scoping (App Context):**
  - **Sandboxes** receive a "scoped" GitHub token valid _only_ for the specific repository they are
    working on, preventing cross-repo data leaks even if the agent tries to access others.
- **Database:** Session records include the `installationId` to enforce boundaries.

---

## 2. Component Changes

### A. Shared Types (`packages/shared`)

We need to propagate the `installationId` context across the stack.

- **`CreateSessionRequest`**: Add `installationId: string`.
- **`SessionState` / `SessionResponse`**: Add `installationId: string`.
- **`EnrichedRepository`**: Ensure it carries `installationId` so the UI knows which installation a
  repo belongs to.

### B. Control Plane (`packages/control-plane`)

#### 1. Authorization & Discovery (`src/auth/github-app.ts` / `src/auth/github.ts`)

- **New Method:** `listUserInstallations(userAccessToken: string)`
  - Calls GitHub API `GET /user/installations` using the user's OAuth token.
  - Returns list of installations accessible to the user.
- **New Method:** `listUserRepositories(userAccessToken: string, installationId: string)`
  - **CRITICAL SECURITY:** Must use `GET /user/installations/{installation_id}/repositories`.
  - Do **NOT** use `GET /installation/repositories` (which uses the App Token), as that lists _all_
    repos the App can access, potentially leaking private/admin repos to unauthorized users in the
    same org.
- **Refactor:** `listInstallationRepositories` (App Token) remains only for backend/system usage
  where User context is unavailable.

#### 2. Router Logic (`src/router.ts`)

- **`handleListRepos`**:
  - **Remove:** Global KV caching of the repo list (since lists are now per-user).
  - **Logic:**
    1. Extract user's OAuth token from request headers.
    2. Call `listUserInstallations` to get accessible installations.
    3. For each installation, call `listUserRepositories`.
    4. Aggregate and return the distinct list of repos the user can access.
- **`handleCreateSession`**:
  - **Input:** Accept `installationId` in the body.
  - **Validation:** Verify the user (via their OAuth token) actually has access to this
    `installationId` and repository before creating the session.
  - **Storage:** Persist `installationId` in the Durable Object state via SQL migration.

### C. Web Client (`packages/web`)

#### 1. Repository Listing (`app/api/repos/route.ts`)

- Pass the logged-in user's GitHub Access Token to the Control Plane (e.g., via `X-GitHub-Token` or
  `Authorization` header).
- This allows the Control Plane to perform the "on-behalf-of" lookup.

#### 2. Session Creation

- When a user selects a repository, include its `installationId` in the `POST /sessions` payload.

### D. Modal Infrastructure (`packages/modal-infra`)

This is the most critical security boundary.

#### 1. GitHub Auth (`src/auth/github_app.py`)

- **Update `generate_installation_token`**:
  - Accept an optional `repositories` argument (list of repo names).
  - When calling GitHub's `POST /app/installations/{id}/access_tokens`, pass
    `repositories=[repo_name]`.
  - **Result:** The generated token is valid _only_ for that specific repository.

#### 2. Web API (`src/web_api.py`)

- **Update `api_create_sandbox`**:
  - Accept `installation_id` in the request body.
  - Call `generate_installation_token` with:
    - `installation_id` (from request)
    - `repositories=[repo_name]` (from request)
  - Pass this **scoped token** to the sandbox environment.

---

## 3. Implementation Plan

### Phase 1: Shared Definitions

1. Update `packages/shared/src/types.ts` with new fields (`installationId`).
2. Create SQL migration in `packages/control-plane/src/session/schema.ts` to add `installation_id`
   to `session` table.

### Phase 2: Control Plane Logic

1. Implement `listUserInstallations` and `listUserRepositories` in
   `packages/control-plane/src/auth/github.ts` (using User Token).
2. Refactor `handleListRepos` in `router.ts` to use dynamic discovery via User Token.
3. Update `handleCreateSession` to store `installationId`.

### Phase 3: Web Frontend

1. Update API route to pass user credentials.
2. Update UI to handle repo selection with installation context.

### Phase 4: Modal Security Hardening

1. Update Python auth logic to support scoped tokens.
2. Enforce `installation_id` requirement in sandbox creation.

### Phase 5: Cleanup

1. Remove `GITHUB_APP_INSTALLATION_ID` from `terraform.tfvars` and environment variables (except
   perhaps as a fallback for background tasks).

---

## 4. Security Verification

After implementation, verify:

1. **Isolation:** Login as User A. Ensure you cannot see repos that belong to User B's organization
   (unless User A is also a member).
2. **Token Scope:** inside a running sandbox, try to `git clone` a _different_ repository in the
   same organization. This **MUST fail** with a permission error.
3. **Database:** Verify `installationId` is correctly stored in the SQLite `session` table.

---

## 5. Plan Review Findings

### User Decisions

| Question | Decision |
|----------|----------|
| OAuth token management | **Refresh token rotation** - store refresh tokens, auto-refresh access tokens |
| Existing sessions on migration | **Invalidate old sessions** - clean break for security |
| Background tasks (scheduler) | **Keep global app token** - scheduler uses broad installation token |
| Token storage in Durable Objects | **Don't store tokens in DO** - fetch fresh from web app on each WS reconnect |

### Critical Gaps Identified

#### 1. GitHub OAuth Refresh Tokens
**Problem:** Standard GitHub OAuth only provides access tokens (8-hour expiry). Refresh tokens require enabling "Expire user authorization tokens" in GitHub App settings.

**Action Required:**
- Verify if setting is enabled (see `docs/GITHUB_APP_VERIFICATION.md`)
- If not enabled: Enable it and update NextAuth config
- Add token refresh logic to `packages/web/src/lib/auth.ts`

**Reference:** https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens

#### 2. Token Refresh Infrastructure
**Current state:** `packages/web/src/lib/auth.ts` stores `accessToken` and `accessTokenExpiresAt` but has no refresh logic.

**Required implementation:**
```typescript
// In jwt callback
if (Date.now() > token.accessTokenExpiresAt - 60000) {
  const refreshed = await refreshAccessToken(token.refreshToken);
  token.accessToken = refreshed.access_token;
  token.accessTokenExpiresAt = Date.now() + refreshed.expires_in * 1000;
}
```

#### 3. Session Invalidation Migration
**Problem:** Plan says invalidate old sessions but doesn't specify how.

**Required:**
- Schema migration to add `installation_id` column (NOT NULL)
- Migration script to close all existing sessions
- KV cleanup for session index entries

#### 4. Installation ID Validation
**Problem:** Plan says "Verify the user has access to this installationId" but doesn't specify mechanism.

**Implementation:**
```typescript
// In handleCreateSession
const userInstallations = await listUserInstallations(userToken);
const hasAccess = userInstallations.some(i => i.id === body.installationId);
if (!hasAccess) {
  return new Response("Unauthorized installation", { status: 403 });
}
```

#### 5. Scoped Token Permissions
**GitHub API for scoped tokens:**
```
POST /app/installations/{installation_id}/access_tokens
{
  "repositories": ["repo-name"],
  "permissions": { "contents": "write", "pull_requests": "write", "metadata": "read" }
}
```

**Recommended permissions:**
- `contents: write` - for git push
- `pull_requests: write` - for PR creation
- `metadata: read` - required baseline

#### 6. Error Handling for Installation Removal
**Problem:** What if GitHub App is uninstalled while sessions are active?

**Recommendation:** Add periodic installation validation or handle 404/401 errors gracefully with user-facing message "Repository access revoked."

#### 7. Rate Limiting Concerns
**Problem:** Per-user API calls to GitHub could hit rate limits (5000/hour per user token).

**Mitigations:**
- Short-lived per-user cache (5 min TTL) for repo lists
- Batch installation queries where possible

### Pre-Implementation Checklist

Before starting implementation:

1. [ ] **Verify GitHub App settings** - Check if "Expire user authorization tokens" is enabled
   - If not enabled: Enable it and update OAuth flow
   - If enabled: Proceed with refresh token implementation
   - See: `docs/GITHUB_APP_VERIFICATION.md`

2. [ ] **Define rollback procedure** - Document how to revert if issues arise
   - Keep `GITHUB_APP_INSTALLATION_ID` as env var (don't delete immediately)
   - Add feature flag `MULTI_TENANT_ENABLED` to toggle modes
   - See: `docs/MULTI_TENANT_ROLLBACK.md`

3. [ ] **Review security implications** - Ensure team understands:
   - Old sessions will be invalidated
   - Users must re-authorize if token expiration enabled
   - Scoped tokens prevent cross-repo access

### Recommended Implementation Order

1. **Phase 0: Verification** (⚠️ MUST DO FIRST)
   - Check GitHub App settings for token expiration
   - Document rollback plan with feature flag
   - Review with team

2. **Phase 1: Shared types**
   - Add `installationId` to types
   - Schema migration with session invalidation

3. **Phase 2: Control plane**
   - User installation discovery
   - Installation validation
   - Update endpoints

4. **Phase 3: Modal security**
   - Scoped token generation
   - Permission specification

5. **Phase 4: Web frontend**
   - Token refresh implementation
   - Installation picker UI
   - Updated API calls

6. **Phase 5: Testing**
   - Automated unit/integration tests
   - Manual security verification
   - Rate limit monitoring

7. **Phase 6: Cleanup**
   - Remove single-tenant fallbacks
   - Remove `GITHUB_APP_INSTALLATION_ID` env var
   - Update documentation

### Files to Modify

| File | Changes |
|------|---------|
| `packages/shared/src/types.ts` | Add `installationId` to Session, SessionState, CreateSessionRequest; add GitHubInstallation type |
| `packages/control-plane/src/session/schema.ts` | Add `installation_id` column (NOT NULL); migration to close old sessions |
| `packages/control-plane/src/auth/github.ts` | Add `listUserInstallations`, `listUserRepositories` (using user token) |
| `packages/control-plane/src/router.ts` | Update `handleListRepos` (user token), `handleCreateSession` (validation) |
| `packages/web/src/lib/auth.ts` | Add `refreshAccessToken`, store refresh_token in JWT, auto-refresh logic |
| `packages/web/src/app/api/repos/route.ts` | Pass user token to control plane via Authorization header |
| `packages/web/src/app/api/sessions/route.ts` | Include `installationId` in request to control plane |
| `packages/modal-infra/src/auth/github_app.py` | Support scoped tokens with `repositories` param and permissions |
| `packages/modal-infra/src/web_api.py` | Accept `installation_id`, generate scoped token, validate HMAC |

### Testing Strategy

#### Automated Tests
1. **Unit tests:**
   - `listUserInstallations` returns correct installations
   - `listUserRepositories` filters by user access
   - Scoped token generation includes correct repo
   - Installation validation in session creation

2. **Integration tests:**
   - Session creation fails without valid `installationId`
   - Session creation fails for unauthorized installation
   - Sandbox cannot clone different repo with scoped token
   - Token refresh flow works correctly

#### Manual Verification
- Login as User A, verify cannot see User B's repos
- In sandbox, attempt `git clone` of different repo (must fail)
- Verify `installationId` stored in SQLite
- Test token refresh after approaching expiry

### Open Questions

1. **Multi-installation repos:** If a repo appears in multiple installations, how should UI handle it?
   - **Decision:** Let user choose installation when creating session

2. **Token expiration setting:** Need to verify current GitHub App configuration
   - **Action:** Complete `docs/GITHUB_APP_VERIFICATION.md` checklist before proceeding
