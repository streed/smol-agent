/**
 * Tree-sitter based syntax lint — inspired by Aider.
 *
 * After edits, parse the modified file with tree-sitter and check for ERROR
 * nodes in the AST. This provides language-agnostic syntax checking without
 * needing language-specific linters installed.
 *
 * Supported languages:
 *   - JavaScript / JSX / MJS / CJS
 *   - TypeScript / TSX
 *   - Python
 *   - Go
 *   - Rust
 *   - Java
 *   - Ruby
 *
 * Key exports:
 *   - lintFile(filePath): Check file for syntax errors
 *   - lintFileFormatted(filePath): Check and return formatted error string
 *
 * Dependencies: node:module, node:fs, node:path, ./logger.js, tree-sitter,
 *               tree-sitter-javascript, tree-sitter-typescript, tree-sitter-python,
 *               tree-sitter-go, tree-sitter-rust, tree-sitter-java, tree-sitter-ruby
 * Depended on by: src/tools/file_tools.js, test/unit/ts-lint.test.js
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);

// ── Types ─────────────────────────────────────────────────────────────

interface SyntaxError {
  line: number;
  column: number;
  text: string;
  type: "missing" | "error";
}

interface LintResult {
  errors: SyntaxError[];
  language: string | null;
}

interface TreeSitterNode {
  type: string;
  isMissing: boolean;
  startPosition: { row: number; column: number };
  childCount: number;
  child(index: number): TreeSitterNode;
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface TreeSitterParser {
  setLanguage(grammar: unknown): void;
  parse(content: string): TreeSitterTree;
}

// ── Lazy-loaded parser ───────────────────────────────────────────────

let _parser: TreeSitterParser | null = null;
const _grammars: Record<string, unknown | null> = {};

function getParser(): TreeSitterParser {
  if (!_parser) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Parser = require("tree-sitter");
    _parser = new Parser() as TreeSitterParser;
  }
  return _parser;
}

function loadGrammar(langKey: string): unknown | null {
  if (_grammars[langKey] !== undefined) return _grammars[langKey];

  try {
    switch (langKey) {
      case "javascript":
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _grammars[langKey] = require("tree-sitter-javascript");
        break;
      case "typescript":
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _grammars[langKey] = require("tree-sitter-typescript").typescript;
        break;
      case "tsx":
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _grammars[langKey] = require("tree-sitter-typescript").tsx;
        break;
      case "python":
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _grammars[langKey] = require("tree-sitter-python");
        break;
      case "go":
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _grammars[langKey] = require("tree-sitter-go");
        break;
      case "rust":
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _grammars[langKey] = require("tree-sitter-rust");
        break;
      case "java":
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _grammars[langKey] = require("tree-sitter-java");
        break;
      case "ruby":
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        _grammars[langKey] = require("tree-sitter-ruby");
        break;
      default:
        _grammars[langKey] = null;
    }
  } catch {
    _grammars[langKey] = null;
  }

  return _grammars[langKey];
}

const EXT_TO_LANG: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
};

/**
 * Check a file for syntax errors using tree-sitter.
 *
 * @param filePath - Absolute path to the file
 * @returns Object with errors array and language
 */
export function lintFile(filePath: string): LintResult {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const langKey = EXT_TO_LANG[ext];
  if (!langKey) {
    return { errors: [], language: null };
  }

  let grammar: unknown | null;
  let content: string;
  let parser: TreeSitterParser;
  let tree: TreeSitterTree;
  try {
    grammar = loadGrammar(langKey);
    if (!grammar) return { errors: [], language: langKey };
    content = fs.readFileSync(filePath, "utf-8");
    parser = getParser();
    parser.setLanguage(grammar);
    tree = parser.parse(content);
  } catch {
    // tree-sitter native module can fail in certain environments (Jest ESM workers)
    return { errors: [], language: langKey };
  }

  // Walk the AST looking for ERROR and MISSING nodes
  const errors: SyntaxError[] = [];
  const lines = content.split("\n");
  const MAX_ERRORS = 10;

  function walk(node: TreeSitterNode): void {
    try {
      if (errors.length >= MAX_ERRORS) return;

      if (node.type === "ERROR" || node.isMissing) {
        const line = node.startPosition.row;
        const col = node.startPosition.column;
        const contextLine = lines[line] || "";
        errors.push({
          line: line + 1,
          column: col + 1,
          text: contextLine.trim().slice(0, 120),
          type: node.isMissing ? "missing" : "error",
        });
      }

      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i));
      }
    } catch {
      // Native tree-sitter node access can fail in certain test environments
    }
  }

  try {
    walk(tree.rootNode);
  } catch {
    return { errors: [], language: langKey };
  }

  if (errors.length > 0) {
    logger.debug(`ts-lint: ${errors.length} syntax errors in ${filePath}`);
  }

  return { errors, language: langKey };
}

/**
 * Check a file for syntax errors and return a formatted string.
 * Returns null if no errors found.
 *
 * @param filePath - Absolute path to the file
 * @returns Formatted error string or null if no errors
 */
export function lintFileFormatted(filePath: string): string | null {
  const { errors, language } = lintFile(filePath);
  if (errors.length === 0) return null;

  const lines = errors.map(e =>
    `  Line ${e.line}:${e.column} — ${e.type}: ${e.text}`
  );

  return `⚠ Syntax errors detected (${language}):\n${lines.join("\n")}`;
}