import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.expo/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "supabase/.temp/**",
      "playwright-report/**",
      ".personal-ai/**",
      // Generated from apps/api/openapi/openapi.yaml by `npm run api:types`; never edited by hand.
      "packages/shared/src/api/schema.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // FIG-1900 (W0.5): all database/storage calls live in packages/shared, never directly in apps/web/src.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@supabase/supabase-js",
              message: "Do not import @supabase/supabase-js in apps/web/src. Put backend calls in packages/shared.",
            },
            {
              name: "@figbloom/shared",
              importNames: ["supabase"],
              message: "Do not call supabase() directly in apps/web/src. Move the query into packages/shared.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='supabase']",
          message: "Do not call supabase() directly in apps/web/src. Move the query into packages/shared.",
        },
      ],
    },
  },
  {
    files: ["apps/api/src/**/*.ts"],
    ignores: ["apps/api/src/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message: "Only src/db may import pg. Pass Tx or IdentityDb into other modules.",
            },
          ],
        },
      ],
    },
  },
  {
    // FIG-1620: one structured, allowlisted logger. console is for the migrate CLI only.
    files: ["apps/api/src/**/*.ts"],
    ignores: ["apps/api/src/db/migrate.ts", "apps/api/src/openapi/**", "apps/api/src/log.ts"],
    rules: { "no-console": "error" },
  },
  {
    files: ["apps/api/test/negative-controls/**/*.mjs", "apps/api/scripts/**/*.mjs", "scripts/supabase-to-api/**/*.mjs"],
    languageOptions: { sourceType: "module", globals: globals.node },
  },
  {
    // RN tooling loads these as plain CommonJS, not ESM — the rest of the repo is "type": "module".
    files: [
      "apps/mobile/babel.config.js", "apps/mobile/metro.config.js", "apps/mobile/jest.config.js", "apps/mobile/jest.setup.js",
    ],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // the Jest setup files call jest.mock
    files: ["apps/mobile/jest.setup.js"],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
  },
);
