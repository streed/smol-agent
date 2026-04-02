/**
 * ESLint configuration for smol-agent
 * Uses flat config format (ESLint 9+)
 */
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        // Node.js globals
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        require: "readonly",
        // Timer globals
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        // AbortController
        AbortController: "readonly",
        // Web APIs available in Node 18+
        fetch: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        // Test globals
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        jest: "readonly",
      },
    },
    rules: {
      // Error prevention
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-console": "off", // We use a custom logger, but console is OK for CLI
      "no-duplicate-imports": "error",
      
      // Code quality
      "prefer-const": "error",
      "no-var": "error",
      "eqeqeq": ["error", "always"],
      "curly": "off", // Codebase uses one-line if statements extensively
      "no-throw-literal": "error",
      
      // Style (not enforced strictly)
      "no-multiple-empty-lines": ["warn", { max: 2, maxEOF: 1 }],
      
      // Async/await best practices
      "no-return-await": "warn",
      
      // Security-conscious rules
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    files: ["test/**/*.js"],
    rules: {
      "no-unused-vars": "off",
      "no-new-func": "off", // Used for testing eval scenarios
    },
  },
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      ".smol-agent/**",
      "*.min.js",
      "dist/**",
      "harbor/**",
    ],
  },
];