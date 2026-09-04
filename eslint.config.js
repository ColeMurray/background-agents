import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/build/**",
      "**/.wrangler/**",
      "**/coverage/**",
      "**/.venv/**",
      "**/venv/**",
      "opencode-reference/**",
      "**/*.d.ts",
      // Bundled/generated files
      "packages/modal-infra/**/*.js",
      // Sandbox runtime JS/TS files run inside sandboxes (Node.js), not part of the TS project
      "packages/sandbox-runtime/**",
    ],
  },

  // Base JS/TS config for all TypeScript files
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Repository-authored and runtime-injected OpenCode extensions run under Node.js.
  {
    files: [".opencode/**/*.{js,ts}"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },

  // TypeScript files configuration
  {
    files: ["packages/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@open-inspect/shared",
              importNames: [
                "TOKEN_VALIDITY_MS",
                "timingSafeEqual",
                "bytesToHex",
                "computeHmacHex",
                "generateInternalToken",
                "verifyCallbackSignature",
                "verifyCallbackFromControlPlane",
              ],
              message: "Import auth-owned names from @open-inspect/shared/auth.",
            },
            {
              name: "@open-inspect/shared",
              importNames: [
                "ACTOR_HEADER",
                "ControlPlaneFetcher",
                "OutboundBinaryBody",
                "OutboundCredentialEnv",
                "OutboundRequestToSign",
                "OutboundServiceCredential",
                "SERVICE_HEADER",
                "SERVICE_NAMES",
                "SERVICE_SIGNATURE_HEADER",
                "SIG1_PREFIX",
                "ServiceName",
                "ServiceSignatureFailure",
                "ServiceSignatureHeaderParse",
                "ServiceSignatureResult",
                "SignedFetchInit",
                "buildCanonicalRequestString",
                "buildOutboundAuthHeaders",
                "buildServiceAuthHeaders",
                "canonicalizeQuery",
                "isServiceName",
                "parseServiceSignatureHeader",
                "resolveOutboundCredential",
                "sha256Hex",
                "signedControlPlaneFetch",
                "verifyServiceSignature",
              ],
              message: "Import service-auth-owned names from @open-inspect/shared/service-auth.",
            },
          ],
        },
      ],
      // Allow console in backend/server code - disable per-file if needed
      "no-console": "off",
    },
  },

  // Control-plane data-layer boundary: all production code must use the
  // injected SqlDatabase (ctx.db, a DO's db field, or a db parameter), never
  // the raw env.DB binding — reading the binding elsewhere would silently
  // bypass the injection path and, on request paths, query instrumentation.
  // The only legitimate reads are the composition roots (the Worker entry,
  // the Hono lifecycle, the Durable Object constructor), each carrying an
  // inline eslint-disable with justification.
  //
  // Platform boundary, same family: Cloudflare's binding types are named
  // only where the Worker's bindings are turned into the platform ports
  // (src/cloudflare/** and src/index.ts). Everything else depends on the
  // port — SqlDatabase, CacheStore, ObjectStorage, SessionRuntimeClient,
  // FetchClient, the queue ports — so it compiles unchanged on the Node host.
  // Flat-config gotcha: a later object's config for the same rule REPLACES
  // the earlier one for files both match, so the exempted files re-declare
  // the env.DB ban that still applies to them.
  {
    files: ["packages/control-plane/src/**/*.ts"],
    ignores: [
      "packages/control-plane/src/**/*.test.ts",
      "packages/control-plane/src/cloudflare/**/*.ts",
      "packages/control-plane/src/index.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'MemberExpression[property.name="DB"]',
          message:
            "Use the injected SqlDatabase (ctx.db / this.db / a db param) instead of env.DB; the binding is read only at composition roots.",
        },
        {
          selector:
            "TSTypeReference[typeName.name=/^(D1Database|D1PreparedStatement|KVNamespace|R2Bucket|DurableObjectNamespace|Fetcher|Queue)$/]",
          message:
            "Cloudflare binding types are named only in src/cloudflare/** and src/index.ts; depend on the platform port (see Platform in types.ts) instead.",
        },
      ],
    },
  },
  {
    files: ["packages/control-plane/src/cloudflare/**/*.ts", "packages/control-plane/src/index.ts"],
    ignores: ["packages/control-plane/src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'MemberExpression[property.name="DB"]',
          message:
            "Use the injected SqlDatabase (ctx.db / this.db / a db param) instead of env.DB; the binding is read only at composition roots.",
        },
      ],
    },
  },

  // Session boundary rules, in the same family as the env.DB ban above. Two
  // bans, both via the base no-restricted-imports rule so they stack with the
  // repo-wide @typescript-eslint/no-restricted-imports paths config:
  //  - the composition root (session/components.ts) is the platform adapter's
  //    private wiring: only cloudflare/durable-object.ts may import it —
  //    services take their dependencies as constructor inputs, never by
  //    reaching into the root;
  //  - the platform adapter (cloudflare/durable-object.ts) is the Cloudflare
  //    edge of the session: only the worker entrypoint may import it, so
  //    nothing the factory builds can hold a reference back to the DO.
  //  - the Node host's adapters (src/node/**) import Node built-ins that the
  //    worker bundle marks external: nothing outside that directory may
  //    import them, so the workerd build cannot pick them up.
  // Flat-config gotcha: a later object's config for the same rule REPLACES
  // the earlier one for files both match, so this general block carries both
  // bans and each exempted file re-declares the ban that still applies to it.
  {
    files: ["packages/control-plane/src/**/*.ts"],
    ignores: [
      "packages/control-plane/src/cloudflare/durable-object.ts",
      "packages/control-plane/src/index.ts",
      "packages/control-plane/src/**/*.test.ts",
      "packages/control-plane/src/node/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Last-segment match: covers any relative depth (./, ../, ../../)
              // and extension-bearing specifiers. The basename is unique in
              // this package, so anchoring on it is precise.
              regex: "(?:^|/)components(?:\\.[cm]?[jt]sx?)?$",
              message:
                "Only the platform adapters (cloudflare/durable-object.ts, node/host.ts) may import the composition root. Take dependencies as constructor inputs instead.",
            },
            {
              regex: "(?:^|/)durable-object(?:\\.[cm]?[jt]sx?)?$",
              message:
                "Only the worker entrypoint (src/index.ts) may import the platform adapter. Depend on the session collaborators, not the Durable Object.",
            },
            {
              // The directory and anything under it, by relative path or the
              // `@/` alias, at any depth: `../node`, `../node/x`, `@/node/y/z`.
              // Package subpaths such as `better-auth/node` are not ours.
              regex: "^(?:\\.\\.?/(?:.*/)?|@/)node(?:/|$)",
              message:
                "Only the Node host (src/node/**) may import its adapters; the worker bundle must not reach node:* modules.",
            },
          ],
        },
      ],
    },
  },
  // The Node host's adapters may import each other but not the Cloudflare
  // edge or the composition root. The Node host itself (src/node/host.ts)
  // is the Node counterpart of the Durable Object adapter: it builds the
  // session runtime, so it may import the composition root, and it alone.
  {
    files: ["packages/control-plane/src/node/**/*.ts"],
    ignores: ["packages/control-plane/src/**/*.test.ts", "packages/control-plane/src/node/host.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(?:^|/)components(?:\\.[cm]?[jt]sx?)?$",
              message:
                "Only the platform adapters (cloudflare/durable-object.ts, node/host.ts) may import the composition root. Take dependencies as constructor inputs instead.",
            },
            {
              regex: "(?:^|/)durable-object(?:\\.[cm]?[jt]sx?)?$",
              message:
                "Only the worker entrypoint (src/index.ts) may import the platform adapter. Depend on the session collaborators, not the Durable Object.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/control-plane/src/node/host.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(?:^|/)durable-object(?:\\.[cm]?[jt]sx?)?$",
              message:
                "Only the worker entrypoint (src/index.ts) may import the platform adapter. Depend on the session collaborators, not the Durable Object.",
            },
          ],
        },
      ],
    },
  },
  // The worker entrypoint may import the adapter (it exports the DO class to
  // the runtime) but not the composition root.
  {
    files: ["packages/control-plane/src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Last-segment match: covers any relative depth (./, ../, ../../)
              // and extension-bearing specifiers. The basename is unique in
              // this package, so anchoring on it is precise.
              regex: "(?:^|/)components(?:\\.[cm]?[jt]sx?)?$",
              message:
                "Only the platform adapters (cloudflare/durable-object.ts, node/host.ts) may import the composition root. Take dependencies as constructor inputs instead.",
            },
            {
              // The directory and anything under it, by relative path or the
              // `@/` alias, at any depth: `../node`, `../node/x`, `@/node/y/z`.
              // Package subpaths such as `better-auth/node` are not ours.
              regex: "^(?:\\.\\.?/(?:.*/)?|@/)node(?:/|$)",
              message:
                "Only the Node host (src/node/**) may import its adapters; the worker bundle must not reach node:* modules.",
            },
          ],
        },
      ],
    },
  },

  // React-specific configuration for web package
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        React: "readonly",
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
    },
  },

  // Web code depends on app-owned auth and request seams. OAuth and session
  // protocol code is owned by the control plane.
  {
    files: ["packages/web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next-auth",
              message: "Use the app-owned browser authentication seams.",
            },
          ],
          patterns: [
            {
              group: ["next-auth/*"],
              message: "Use the app-owned browser authentication seams.",
            },
            {
              regex: "(?:^|/)lib/auth$",
              message: "Use getServerAuthSession from @/lib/server-auth-session.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/web/src/**/*.{ts,tsx}"],
    ignores: [
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
      "packages/web/src/lib/browser-api-fetch.ts",
      "packages/web/src/lib/control-plane-transport.ts",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Use an app-owned HTTP transport instead of raw fetch.",
        },
      ],
    },
  },
  // Cloudflare Workers specific config
  {
    files: ["packages/control-plane/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.worker,
        WebSocketPair: "readonly",
        DurableObjectState: "readonly",
        DurableObjectStorage: "readonly",
        DurableObjectId: "readonly",
        DurableObjectNamespace: "readonly",
        ExecutionContext: "readonly",
        ScheduledEvent: "readonly",
      },
    },
  },

  // Test files configuration
  {
    files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // Disable rules that conflict with Prettier
  eslintConfigPrettier
);
