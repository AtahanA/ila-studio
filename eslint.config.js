import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// What "npm run lint" checks: the TypeScript sources under src. Formatting is not its business (.editorconfig).
export default defineConfig([
  globalIgnores(["dist/", "src-tauri/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    rules: {
      // a hint, not an error: some dependency lists are short on purpose (an effect that runs once, or one that
      // follows only part of what it reads)
      "react-hooks/exhaustive-deps": "warn",
      // Off: these check what the React Compiler needs, which this project does not use, and the code does on
      // purpose what they flag - refs that hold the latest value are written during render, effects reset state.
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
]);
