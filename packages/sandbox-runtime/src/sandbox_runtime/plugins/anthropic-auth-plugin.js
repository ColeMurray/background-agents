/**
 * Anthropic Auth Proxy Plugin for Open-Inspect.
 *
 * Keeps subscription credentials in the control plane and adapts Anthropic
 * requests to the headers expected by the Claude subscription API.
 */

import { createProviderTokenBroker } from "./provider-token-broker.js";
import { createHash } from "node:crypto";

const OAUTH_SENTINEL = "managed-by-control-plane";
// The subscription API gates newer models on the reported client version, so this
// must stay at or above the highest floor any catalog model requires. Claude Fable
// 5.1 refuses anything below 2.1.251. Bump it when the API rejects a newly added
// model with a "does not support this model" error.
const CLAUDE_VERSION = "2.1.251";
const CLAUDE_USER_AGENT = `claude-cli/${CLAUDE_VERSION} (external, cli)`;
const REQUIRED_BETAS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];
const CLAUDE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const BILLING_SALT = "59cf53e54c78";
const BILLING_POSITIONS = [4, 7, 20];
const TOOL_PREFIX = "mcp_";
const ACCOUNT_LIMIT_MESSAGE = "This request would exceed your account's rate limit";
const tokenBroker = createProviderTokenBroker({
  provider: "anthropic",
  providerLabel: "Anthropic",
});

function isManagedOAuth(auth) {
  return auth?.type === "oauth" && auth.refresh === OAUTH_SENTINEL;
}

function mergeHeaders(requestInput, init) {
  const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

function addRequiredBetas(headers) {
  const betas = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  headers.set("anthropic-beta", [...new Set([...betas, ...REQUIRED_BETAS])].join(","));
}

function addMessagesBeta(url) {
  const rewritten = new URL(url);
  if (rewritten.pathname === "/v1/messages" && !rewritten.searchParams.has("beta")) {
    rewritten.searchParams.set("beta", "true");
  }
  return rewritten;
}

function sanitizeSystemText(text) {
  const paragraphs = text.split(/\n\n+/).filter((paragraph) => {
    return (
      !paragraph.includes("You are OpenCode") &&
      !paragraph.includes("github.com/anomalyco/opencode") &&
      !paragraph.includes("opencode.ai/docs")
    );
  });
  return paragraphs
    .join("\n\n")
    .replace("if OpenCode honestly", "if the assistant honestly")
    .replace(
      "Here is some useful information about the environment you are running in:",
      "Environment context you are running in:"
    )
    .trim();
}

function claudeSystem(system) {
  const identity = { type: "text", text: CLAUDE_IDENTITY };
  if (system == null) return [identity];
  const blocks = Array.isArray(system) ? system : [system];
  const sanitized = blocks.flatMap((block) => {
    if (typeof block === "string") {
      const text = sanitizeSystemText(block);
      return text ? [{ type: "text", text }] : [];
    }
    if (block && typeof block === "object" && typeof block.text === "string") {
      const text = sanitizeSystemText(block.text);
      return text ? [{ ...block, type: "text", text }] : [];
    }
    return [];
  });
  return sanitized[0]?.text === CLAUDE_IDENTITY ? sanitized : [identity, ...sanitized];
}

function firstUserText(messages) {
  const content = messages?.find((message) => message?.role === "user")?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? (content.find((block) => block?.type === "text")?.text ?? "")
    : "";
}

function billingHeader(messages) {
  const text = firstUserText(messages);
  const chars = BILLING_POSITIONS.map((position) => text[position] || "0").join("");
  const suffix = createHash("sha256")
    .update(`${BILLING_SALT}${chars}${CLAUDE_VERSION}`)
    .digest("hex")
    .slice(0, 3);
  const cch = createHash("sha256").update(text).digest("hex").slice(0, 5);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=${cch};`;
}

function prefixToolName(name) {
  if (name === "StructuredOutput") return name;
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function rewriteRequestBody(body) {
  if (typeof body !== "string") return body;
  try {
    const parsed = JSON.parse(body);
    const system = claudeSystem(parsed.system);
    if (
      Array.isArray(parsed.messages) &&
      parsed.messages.some((message) => message?.role === "user")
    ) {
      system.unshift({ type: "text", text: billingHeader(parsed.messages) });
    }
    parsed.system = system;
    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) =>
        tool?.name ? { ...tool, name: prefixToolName(tool.name) } : tool
      );
    }
    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => ({
        ...message,
        content: Array.isArray(message?.content)
          ? message.content.map((block) =>
              block?.type === "tool_use" && block.name
                ? { ...block, name: prefixToolName(block.name) }
                : block
            )
          : message?.content,
      }));
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function stripToolNames(text) {
  return text.replace(/"name"\s*:\s*"mcp_([^"\\]{1,200})"/g, (_match, name) => {
    const restored =
      name === "StructuredOutput" ? name : `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
    return `"name":"${restored}"`;
  });
}

function rewriteResponse(response) {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const body = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const splitAt = pending.lastIndexOf("\n");
        if (splitAt < 0) return;
        controller.enqueue(encoder.encode(stripToolNames(pending.slice(0, splitAt + 1))));
        pending = pending.slice(splitAt + 1);
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(stripToolNames(pending)));
      },
    })
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function makeAccountLimitNonRetryable(response) {
  if (response.status !== 429) return response;

  const body = await response.clone().text();
  if (!body.includes(ACCOUNT_LIMIT_MESSAGE)) return response;

  // AI SDK retries every 429. Subscription account limits cannot recover within
  // this prompt, so expose the provider error as terminal instead of retrying forever.
  return new Response(response.body, {
    status: 400,
    statusText: "Account limit reached",
    headers: response.headers,
  });
}

export const AnthropicAuthProxy = async () => ({
  provider: {
    id: "anthropic",
    async models(provider, { auth }) {
      if (!isManagedOAuth(auth)) return provider.models;
      return Object.fromEntries(
        Object.entries(provider.models).map(([id, model]) => [
          id,
          {
            ...model,
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        ])
      );
    },
  },
  auth: {
    provider: "anthropic",
    methods: [],
    async loader(getAuth) {
      const auth = await getAuth();
      if (!isManagedOAuth(auth)) return {};

      return {
        apiKey: "",
        async fetch(requestInput, init) {
          const currentAuth = await getAuth();
          if (!isManagedOAuth(currentAuth)) return fetch(requestInput, init);

          const headers = mergeHeaders(requestInput, init);
          headers.delete("x-api-key");
          headers.set("user-agent", CLAUDE_USER_AGENT);
          addRequiredBetas(headers);

          const originalUrl =
            requestInput instanceof Request
              ? requestInput.url
              : requestInput instanceof URL
                ? requestInput.href
                : requestInput;
          const url = addMessagesBeta(originalUrl);
          const rewrittenInput =
            requestInput instanceof Request ? new Request(url, requestInput) : url;

          let requestBody = init?.body;
          if (requestBody === undefined && requestInput instanceof Request && requestInput.body) {
            requestBody = await requestInput.clone().text();
          }
          const body = rewriteRequestBody(requestBody);
          const { accessToken } = await tokenBroker.getAccessToken();
          headers.set("authorization", `Bearer ${accessToken}`);
          const providerResponse = await fetch(rewrittenInput, { ...init, headers, body });
          const classifiedResponse = await makeAccountLimitNonRetryable(providerResponse);
          return rewriteResponse(classifiedResponse);
        },
      };
    },
  },
});
