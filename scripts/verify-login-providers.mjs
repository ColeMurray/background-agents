#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const PROVIDERS = [
  ["github", "Sign in with GitHub"],
  ["google", "Sign in with Google"],
];
const LOGIN_REQUEST_TIMEOUT_MS = 10_000;

export function parseExpectedProviders(value) {
  const providers = value.split(",");
  const canonical = PROVIDERS.map(([provider]) => provider).filter((provider) =>
    providers.includes(provider)
  );

  if (
    providers.length === 0 ||
    providers.some((provider) => provider === "") ||
    new Set(providers).size !== providers.length ||
    providers.some((provider) => !PROVIDERS.some(([known]) => known === provider)) ||
    canonical.join(",") !== value
  ) {
    throw new Error("Expected providers must be github, google, or github,google");
  }

  return providers;
}

export async function verifyLoginProviders(webUrl, expectedValue, fetchImpl = fetch) {
  const expected = parseExpectedProviders(expectedValue);
  const loginUrl = new URL("/login", webUrl);
  if (!["http:", "https:"].includes(loginUrl.protocol) || loginUrl.username || loginUrl.password) {
    throw new Error("Web URL must be an HTTP(S) origin without credentials");
  }

  let response;
  try {
    response = await fetchImpl(loginUrl.href, {
      headers: { accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
      throw new Error("Timed out waiting for the login page", { cause: error });
    }
    throw new Error("Could not request the login page", { cause: error });
  }
  if (!response.ok) {
    throw new Error(`Login page returned HTTP ${response.status}`);
  }

  const html = await response.text();
  for (const [provider, label] of PROVIDERS) {
    const rendered = html.includes(label);
    if (expected.includes(provider) && !rendered) {
      throw new Error(`Missing login provider: ${provider}`);
    }
    if (!expected.includes(provider) && rendered) {
      throw new Error(`Unexpected login provider: ${provider}`);
    }
  }

  return expected;
}

async function main() {
  const [webUrl, expectedProviders] = process.argv.slice(2);
  if (!webUrl || !expectedProviders) {
    throw new Error(
      "Usage: node scripts/verify-login-providers.mjs <web-url> <github|google|github,google>"
    );
  }

  const providers = await verifyLoginProviders(webUrl, expectedProviders);
  console.log(`Verified /login providers: ${providers.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Login provider verification failed");
    process.exitCode = 1;
  });
}
