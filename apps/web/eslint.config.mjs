import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-acceptance/**",
    "out/**",
    "build/**",
    ".uv-cache/**",
    ".claude/**",
    "next-env.d.ts",
    // Generated design-sync output and local artifacts:
    ".playwright-cli/**",
    ".design-sync/**",
    ".ds-sync/**",
    "ds-bundle/**",
    "output/**",
    // Vendored Ghost theme (a fork of Ghost's Source theme) and its built JS:
  ]),
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSAsExpression",
          message:
            "Chained type assertions (x as A as B) fabricate type evidence. Validate or parse the value instead.",
        },
      ],
    },
  },
  {
    // Test fixtures may cast partial objects into full types.
    files: ["tests/**"],
    rules: { "no-restricted-syntax": "off" },
  },
]);

export default eslintConfig;
