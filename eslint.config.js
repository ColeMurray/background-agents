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
      "opencode-reference/**",
      "**/*.d.ts",
      // Bundled/generated files and sandbox plugins
      "packages/modal-infra/**/*.js",
      "packages/sandbox/**/*.js",
    ],
  },

  // Base JS/TS config for all TypeScript files
  js.configs.recommended,
  ...tseslint.configs.recommended,

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
      // Allow console in backend/server code - disable per-file if needed
      "no-console": "off",
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
