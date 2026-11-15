// Platform file (trusted, shipped by automation/). Fixed lint rules for generated bundles. The toolkit's
// `validate` command always lints with this file (never with a config found in the bundle).
import tseslint from "typescript-eslint";

const noFixedWaits = [
  {
    selector: "CallExpression[callee.property.name='waitForTimeout']",
    message: "Fixed waits are not allowed (waitForTimeout); use a web-first assertion instead.",
  },
  {
    selector: "CallExpression[callee.name=/^(setTimeout|setInterval)$/]",
    message: "Timer-based waits are not allowed; use a web-first assertion instead.",
  },
  {
    selector: "MemberExpression[property.name='only']",
    message: "Focused tests (.only) are not allowed.",
  },
];

const noRawLocatorsInSpecs = [
  {
    selector: "CallExpression[callee.object.name='page'][callee.property.name='locator']",
    message: "Use the page object's accessible locators (getByRole, getByLabel, …) instead of CSS/XPath in specs.",
  },
  {
    selector: "CallExpression[callee.property.name='locator'] > Literal[value=/^(xpath=|\\/\\/|css=)/]",
    message: "XPath/CSS engine selectors are not allowed in specs.",
  },
];

export default tseslint.config(
  { ignores: ["node_modules/**", "test-results/**", "playwright-report/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: "module" },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-restricted-syntax": ["error", ...noFixedWaits],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-debugger": "error",
    },
  },
  {
    files: ["tests/**/*.spec.ts"],
    rules: { "no-restricted-syntax": ["error", ...noFixedWaits, ...noRawLocatorsInSpecs] },
  },
);
