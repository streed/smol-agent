/**
 * Tree-sitter based syntax lint — inspired by Aider.
 *
 * After edits, parse the modified file with tree-sitter and check for ERROR
 * nodes in the AST. This provides language-agnostic syntax checking without
 * needing language-specific linters installed.
 *
 * Returns a list of syntax errors with line numbers and context.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);

// ── Lazy-loaded parser ───────────────────────────────────────────────

let _parser = null;
const _grammars = {};

function getParser() {
  if (!_parser) {
    const Parser = require("tree-sitter");
    _parser = new Parser();
  }
  return _parser;
}

function loadGrammar(langKey) {
  if (_grammars[langKey] !== undefined) return _grammars[langKey];

  try {
    switch (langKey) {
      case "javascript":
        _grammars[langKey] = require("tree-sitter-javascript");
        break;
      case "typescript":
        _grammars[langKey] = require("tree-sitter-typescript").typescript;
        break;
      case "tsx":
        _grammars[langKey] = require("tree-sitter-typescript").tsx;
        break;
      case "python":
        _grammars[langKey] = require("tree-sitter-python");
        break;
      case "go":
        _grammars[langKey] = require("tree-sitter-go");
        break;
      case "rust":
        _grammars[langKey] = require("tree-sitter-rust");
        break;
      case "java":
        _grammars[langKey] = require("tree-sitter-java");
        break;
      case "ruby":
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

const EXT_TO_LANG = {
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
 * @param {string} filePath - Absolute path to the file
 * @returns {{ errors: Array<{ line: number, column: number, text: string }>, language: string|null }}
 */
export function lintFile(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const langKey = EXT_TO_LANG[ext];
  if (!langKey) {
    return { errors: [], language: null };
  }

  let grammar, content, parser, tree;
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
  const errors = [];
  const lines = content.split("\n");
  const MAX_ERRORS = 10;

  function walk(node) {
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
 * @param {string} filePath - Absolute path to the file
 * @returns {string|null}
 */
export function lintFileFormatted(filePath) {
  const { errors, language } = lintFile(filePath);
  if (errors.length === 0) return null;

  const lines = errors.map(e =>
    `  Line ${e.line}:${e.column} — ${e.type}: ${e.text}`
  );

  return `⚠ Syntax errors detected (${language}):\n${lines.join("\n")}`;
}
