import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default [
  { ignores: ["**/dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] } },
  { files: ["**/*.mjs", "**/*.config.js"], languageOptions: { globals: globals.node } },
  { files: ["**/e2e/**"], languageOptions: { globals: { ...globals.node, ...globals.browser, chrome: "readonly" } } },
];
