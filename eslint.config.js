import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "generated/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    // Plain JS/Node scripts get no TypeScript layer at all, so unlike the
    // *.ts block below — which turns no-undef off and leans on tsc + @types
    // /node instead — this is the only thing that would ever catch a typo'd
    // or genuinely undefined identifier here. Keep the rule on; declare the
    // globals it needs instead.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // supertest's res.body is untyped (any) by design — asserting against it
    // is normal test code, not a real type-safety gap worth casting everywhere.
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
);
