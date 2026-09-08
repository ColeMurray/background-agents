-- Better Auth browser identity, account, and session authority.
--
-- This schema is generated from the exact-pinned Better Auth 1.6.25 core
-- configuration in packages/control-plane/src/auth/user/better-auth.ts. It is
-- additive and inert until the final browser-auth routes are activated.
--
-- At activation, auth_users.id is projected unchanged into canonical users.id.
-- auth_accounts then owns browser-provider credentials; the legacy
-- provider_credentials table is not dual-written by this runtime.

CREATE TABLE auth_users (
  id              TEXT NOT NULL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  emailVerified   INTEGER NOT NULL,
  image           TEXT,
  createdAt       DATE NOT NULL,
  updatedAt       DATE NOT NULL,
  CHECK (emailVerified IN (0, 1))
);

CREATE TABLE auth_sessions (
  id          TEXT NOT NULL PRIMARY KEY,
  expiresAt   DATE NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  createdAt   DATE NOT NULL,
  updatedAt   DATE NOT NULL,
  ipAddress   TEXT,
  userAgent   TEXT,
  userId      TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES auth_users(id) ON DELETE CASCADE
);

CREATE INDEX auth_sessions_userId_idx
  ON auth_sessions(userId);

CREATE TABLE auth_accounts (
  id                    TEXT NOT NULL PRIMARY KEY,
  accountId             TEXT NOT NULL,
  providerId            TEXT NOT NULL,
  userId                 TEXT NOT NULL,
  accessToken            TEXT,
  refreshToken           TEXT,
  idToken                TEXT,
  accessTokenExpiresAt   DATE,
  refreshTokenExpiresAt  DATE,
  scope                   TEXT,
  password                TEXT,
  createdAt               DATE NOT NULL,
  updatedAt               DATE NOT NULL,
  FOREIGN KEY (userId) REFERENCES auth_users(id) ON DELETE CASCADE
);

CREATE INDEX auth_accounts_userId_idx
  ON auth_accounts(userId);

-- Better Auth 1.6.25 does not generate this uniqueness constraint. Provider
-- subject is the immutable sign-in identity and must resolve to one account.
CREATE UNIQUE INDEX idx_auth_accounts_provider_identity
  ON auth_accounts(providerId, accountId);

CREATE TABLE auth_verifications (
  id          TEXT NOT NULL PRIMARY KEY,
  identifier  TEXT NOT NULL,
  value       TEXT NOT NULL,
  expiresAt   DATE NOT NULL,
  createdAt   DATE NOT NULL,
  updatedAt   DATE NOT NULL
);

CREATE INDEX auth_verifications_identifier_idx
  ON auth_verifications(identifier);
