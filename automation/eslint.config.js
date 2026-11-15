// Lint config for the toolkit's own code (src/, test/, platform/). Generated bundles are linted with
// platform/eslint.config.js instead.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".runs/**", "test-results/**", "playwright-report/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
