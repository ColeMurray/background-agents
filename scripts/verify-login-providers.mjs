#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { parse } from "parse5";

const PROVIDERS = ["github", "google"];
const PROVIDER_MARKER = "data-sign-in-provider";
const LOGIN_REQUEST_TIMEOUT_MS = 10_000;

export function parseExpectedProviders(value) {
  const providers = value.split(",");
  const canonical = PROVIDERS.filter((provider) => providers.includes(provider));

  if (
    providers.length === 0 ||
    providers.some((provider) => provider === "") ||
    new Set(providers).size !== providers.length ||
    providers.some((provider) => !PROVIDERS.includes(provider)) ||
    canonical.join(",") !== value
  ) {
    throw new Error("Expected providers must be github, google, or github,google");
  }

  return providers;
}

function collectRenderedProviders(html) {
  const rendered = [];

  function visit(node) {
    const marker = node.attrs?.find((attribute) => attribute.name === PROVIDER_MARKER);
    if (marker) rendered.push(marker.value);
    for (const child of node.childNodes ?? []) visit(child);
  }

  visit(parse(html));
  return rendered;
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
  const rendered = collectRenderedProviders(html);
  if (
    rendered.length !== expected.length ||
    rendered.some((provider, index) => provider !== expected[index])
  ) {
    throw new Error("Rendered login providers do not match expected providers");
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
