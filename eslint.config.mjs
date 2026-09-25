import eslint from "@eslint/js";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "crypto-eval-review/**",
      ".codex-remote-attachments/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: { project: "./tsconfig.eslint.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { console: "readonly", URL: "readonly", process: "readonly" },
      parserOptions: { project: null },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    files: ["apps/dashboard/public/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        fetch: "readonly",
        setInterval: "readonly",
      },
    },
    rules: { "security/detect-object-injection": "off" },
  },
);
