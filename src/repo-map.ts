/**
 * Repository Map — inspired by Aider's tree-sitter repo map.
 *
 * Builds a compact "table of contents" for the codebase showing key symbols
 * (functions, classes, exports, types) with their file locations. This gives
 * the agent structural understanding without requiring multiple grep/read calls.
 *
 * Uses tree-sitter for accurate AST-based symbol extraction across languages:
 *   - JavaScript / JSX
 *   - Python
 *   - Go
 *   - TypeScript / TSX, Rust, Java, Ruby (if grammars are installed)
 *
 * Design:
 *   - Scans source files in the project (respects ignore patterns)
 *   - Parses each file with the appropriate tree-sitter grammar
 *   - Extracts top-level symbols (functions, classes, types, exports)
 *   - Fits the map within a configurable token budget
 *   - Caches results for fast re-use within a session
 *
 * Key exports:
 *   - buildRepoMap(cwd, options): Build a repo map string
 *   - clearRepoMapCache(): Clear the cached map
 *   - computePageRank(files): Compute importance scores for files
 *
 * Dependencies: node:module, node:fs/promises, node:path, ./logger.js,
 *               tree-sitter, tree-sitter-javascript, tree-sitter-typescript,
 *               tree-sitter-python, tree-sitter-go, tree-sitter-rust,
 *               tree-sitter-java, tree-sitter-ruby
 * Depended on by: src/context.js, test/unit/repo-map.test.js
 */

import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.js";

// tree-sitter is CJS — bridge to ESM
const require = createRequire(import.meta.url);

// ── tree-sitter for AST parsing ───────────────────────────────────────

// ── Lazy-loaded grammars ──────────────────────────────────────────────

interface TreeSitterNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  child(index: number): TreeSitterNode;
  children: TreeSitterNode[];
}

interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

interface TreeSitterParser {
  setLanguage(grammar: unknown): void;
  parse(content: string): TreeSitterTree;
}

interface Grammar {
  // tree-sitter grammar object
}

let _parser: TreeSitterParser | null = null;
const _grammars: Record<string, Grammar | null> = {};

function getParser(): TreeSitterParser | null {
  if (!_parser) {
    try {
      const Parser = require("tree-sitter");
      _parser = new Parser();
    } catch {
      return null;
    }
  }
  return _parser;
}

/**
 * Load a tree-sitter grammar by language key.
 * Returns the grammar object or null if not available.
 */
function loadGrammar(langKey: string): Grammar | null {
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

// ── Types ─────────────────────────────────────────────────────────────

interface FileEntry {
  path: string;
  lang: string;
}

interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
}

interface SymbolExtractor {
  (node: TreeSitterNode): SymbolInfo[];
}

// ── Symbol extractors by language ─────────────────────────────────────

/**
 * Extract name from a function/class declaration node.
 */
function extractName(node: TreeSitterNode): string {
  // Try the 'name' child first
  for (const child of node.children) {
    if (child.type === "identifier" || child.type === "property_identifier" ||
        child.type === "type_identifier" || child.type === "type_identifier") {
      return child.text;
    }
  }
  // Fallback: find first identifier child
  for (const child of node.children) {
    if (child.type.includes("identifier")) {
      return child.text;
    }
  }
  return "(anonymous)";
}

/**
 * Extract export name from various export forms.
 */
function extractExportName(node: TreeSitterNode): string {
  // export function foo() {}
  // export class Foo {}
  // export const foo = ...
  // export { foo, bar }
  // export default foo

  for (const child of node.children) {
    if (child.type === "function_declaration" || child.type === "class_declaration" ||
        child.type === "lexical_declaration" || child.type === "variable_declaration") {
      return extractName(child);
    }
    if (child.type === "export_clause") {
      // export { foo, bar }
      const names: string[] = [];
      for (const spec of child.children) {
        if (spec.type === "export_specifier") {
          names.push(extractName(spec));
        }
      }
      return names.join(", ");
    }
    if (child.type === "identifier") {
      return child.text;
    }
  }
  return "(export)";
}

/**
 * Extract symbols from JavaScript/TypeScript AST.
 */
function extractJSTSSymbols(node: TreeSitterNode): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  function walk(n: TreeSitterNode): void {
    const type = n.type;

    // Function declarations
    if (type === "function_declaration" || type === "generator_function_declaration") {
      symbols.push({ name: extractName(n), kind: "fn", line: n.startPosition.row + 1 });
      return; // Don't recurse into function body
    }

    // Class declarations
    if (type === "class_declaration") {
      symbols.push({ name: extractName(n), kind: "class", line: n.startPosition.row + 1 });
      // Extract class methods
      for (const child of n.children) {
        if (child.type === "class_body") {
          for (const member of child.children) {
            if (member.type === "method_definition" || member.type === "public_field_definition") {
              symbols.push({ name: extractName(member), kind: "method", line: member.startPosition.row + 1 });
            }
          }
        }
      }
      return;
    }

    // Variable declarations (const, let, var)
    if (type === "lexical_declaration" || type === "variable_declaration") {
      for (const child of n.children) {
        if (child.type === "variable_declarator") {
          const nameNode = child.child(0);
          if (nameNode) {
            const kind = n.type === "lexical_declaration" ? "const" : "let";
            symbols.push({ name: nameNode.text, kind, line: n.startPosition.row + 1 });
          }
        }
      }
      return;
    }

    // Export statements - recurse to find the actual declaration
    if (type === "export_statement") {
      // Recurse into children to find function/class declarations
      for (const child of n.children) {
        if (child.type === "function_declaration" || child.type === "class_declaration") {
          walk(child);
          return;
        }
        if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
          walk(child);
          return;
        }
      }
      // Fallback: just mark as export if no declaration found
      const name = extractExportName(n);
      if (name && name !== "(export)") {
        symbols.push({ name, kind: "export", line: n.startPosition.row + 1 });
      }
      return;
    }

    // Interface declarations (TypeScript)
    if (type === "interface_declaration") {
      symbols.push({ name: extractName(n), kind: "interface", line: n.startPosition.row + 1 });
      return;
    }

    // Type declarations (TypeScript)
    if (type === "type_alias_declaration") {
      symbols.push({ name: extractName(n), kind: "type", line: n.startPosition.row + 1 });
      return;
    }

    // Enum declarations (TypeScript)
    if (type === "enum_declaration") {
      symbols.push({ name: extractName(n), kind: "enum", line: n.startPosition.row + 1 });
      return;
    }

    // Recurse into children
    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return symbols;
}

/**
 * Extract symbols from a JavaScript/TypeScript node.
 */
function extractJSTSNode(node: TreeSitterNode): SymbolInfo[] {
  // Handle program node specifically
  if (node.type === "program") {
    return extractJSTSSymbols(node);
  }
  return extractJSTSSymbols(node);
}

/**
 * Extract symbols from Python AST.
 */
function extractPythonSymbols(node: TreeSitterNode): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  function walk(n: TreeSitterNode): void {
    const type = n.type;

    if (type === "function_definition") {
      const name = extractName(n);
      // Skip private functions (starting with _)
      if (!name.startsWith("_")) {
        symbols.push({ name, kind: "fn", line: n.startPosition.row + 1 });
      }
      return; // Don't recurse into function body
    }

    if (type === "class_definition") {
      const name = extractName(n);
      // Skip private classes
      if (!name.startsWith("_")) {
        symbols.push({ name, kind: "class", line: n.startPosition.row + 1 });
        // Extract class methods
        for (const child of n.children) {
          if (child.type === "block") {
            for (const member of child.children) {
              if (member.type === "function_definition") {
                const methodName = extractName(member);
                if (!methodName.startsWith("_")) {
                  symbols.push({ name: methodName, kind: "method", line: member.startPosition.row + 1 });
                }
              }
            }
          }
        }
      }
      return;
    }

    if (type === "import_statement") {
      // import foo
      for (const child of n.children) {
        if (child.type === "dotted_name" || child.type === "identifier") {
          symbols.push({ name: child.text, kind: "import", line: n.startPosition.row + 1 });
        }
      }
      return;
    }

    if (type === "import_from_statement") {
      // from foo import bar
      // Just mark the module being imported from
      for (const child of n.children) {
        if (child.type === "dotted_name") {
          symbols.push({ name: child.text, kind: "import", line: n.startPosition.row + 1 });
          break;
        }
      }
      return;
    }

    // Recurse
    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return symbols;
}

/**
 * Extract symbols from Go AST.
 */
function extractGoSymbols(node: TreeSitterNode): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  function walk(n: TreeSitterNode): void {
    const type = n.type;

    if (type === "function_declaration") {
      symbols.push({ name: extractName(n), kind: "fn", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "method_declaration") {
      symbols.push({ name: extractName(n), kind: "method", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "type_declaration") {
      for (const child of n.children) {
        if (child.type === "type_spec") {
          const nameNode = child.child(0);
          if (nameNode) {
            symbols.push({ name: nameNode.text, kind: "type", line: n.startPosition.row + 1 });
          }
        }
      }
      return;
    }

    if (type === "import_declaration") {
      for (const child of n.children) {
        if (child.type === "import_spec") {
          const pathNode = child.child(child.childCount - 1);
          if (pathNode) {
            symbols.push({ name: pathNode.text, kind: "import", line: n.startPosition.row + 1 });
          }
        }
      }
      return;
    }

    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return symbols;
}

/**
 * Extract symbols from Rust AST.
 */
function extractRustSymbols(node: TreeSitterNode): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  function walk(n: TreeSitterNode): void {
    const type = n.type;

    if (type === "function_item") {
      symbols.push({ name: extractName(n), kind: "fn", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "struct_item") {
      symbols.push({ name: extractName(n), kind: "struct", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "enum_item") {
      symbols.push({ name: extractName(n), kind: "enum", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "trait_item") {
      symbols.push({ name: extractName(n), kind: "trait", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "impl_item") {
      // impl Foo or impl Foo for Bar
      for (const child of n.children) {
        if (child.type === "type_identifier") {
          symbols.push({ name: child.text, kind: "impl", line: n.startPosition.row + 1 });
          break;
        }
      }
      return;
    }

    if (type === "use_declaration") {
      for (const child of n.children) {
        if (child.type === "scoped_identifier" || child.type === "identifier") {
          symbols.push({ name: child.text, kind: "use", line: n.startPosition.row + 1 });
        }
      }
      return;
    }

    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return symbols;
}

/**
 * Extract symbols from Java AST.
 */
function extractJavaSymbols(node: TreeSitterNode): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  function walk(n: TreeSitterNode): void {
    const type = n.type;

    if (type === "method_declaration") {
      symbols.push({ name: extractName(n), kind: "method", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "class_declaration") {
      symbols.push({ name: extractName(n), kind: "class", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "interface_declaration") {
      symbols.push({ name: extractName(n), kind: "interface", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "enum_declaration") {
      symbols.push({ name: extractName(n), kind: "enum", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "import_declaration") {
      for (const child of n.children) {
        if (child.type === "scoped_identifier" || child.type === "identifier") {
          symbols.push({ name: child.text, kind: "import", line: n.startPosition.row + 1 });
        }
      }
      return;
    }

    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return symbols;
}

/**
 * Extract symbols from Ruby AST.
 */
function extractRubySymbols(node: TreeSitterNode): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  function walk(n: TreeSitterNode): void {
    const type = n.type;

    if (type === "method") {
      symbols.push({ name: extractName(n), kind: "fn", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "class") {
      symbols.push({ name: extractName(n), kind: "class", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "module") {
      symbols.push({ name: extractName(n), kind: "module", line: n.startPosition.row + 1 });
      return;
    }

    if (type === "singleton_method") {
      symbols.push({ name: extractName(n), kind: "method", line: n.startPosition.row + 1 });
      return;
    }

    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return symbols;
}

// Map language keys to extractors
const LANG_EXTRACTORS: Record<string, SymbolExtractor> = {
  javascript: extractJSTSNode,
  typescript: extractJSTSNode,
  tsx: extractJSTSNode,
  python: extractPythonSymbols,
  go: extractGoSymbols,
  rust: extractRustSymbols,
  java: extractJavaSymbols,
  ruby: extractRubySymbols,
};

// ── Reference extraction for PageRank ───────────────────────────────────

/**
 * Extract identifier references from an AST.
 * Used for computing cross-file importance (PageRank).
 */
function extractReferences(node: TreeSitterNode): Set<string> {
  const refs = new Set<string>();

  function walk(n: TreeSitterNode): void {
    // Collect identifier references
    if (n.type === "identifier" || n.type === "type_identifier" || n.type === "property_identifier") {
      refs.add(n.text);
    }
    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return refs;
}

// ── PageRank computation ──────────────────────────────────────────────

interface FileSymbols {
  path: string;
  symbols: SymbolInfo[];
}

/**
 * Compute PageRank scores for files based on cross-file references.
 * Files that are referenced by many other files get higher scores.
 */
export function computePageRank(
  fileSymbols: Map<string, SymbolInfo[]>,
  fileRefs: Map<string, Set<string>>
): Map<string, number> {
  // Build file index: symbol -> file
  const symbolToFile = new Map<string, string>();
  for (const [filePath, symbols] of fileSymbols) {
    for (const sym of symbols) {
      symbolToFile.set(sym.name, filePath);
    }
  }

  // Build adjacency list: file A -> [files it references]
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();

  // Initialize all files
  for (const filePath of fileSymbols.keys()) {
    outgoing.set(filePath, new Set());
    incoming.set(filePath, new Set());
  }

  // Build edges
  for (const [filePath, refs] of fileRefs) {
    for (const ref of refs) {
      const targetFile = symbolToFile.get(ref);
      if (targetFile && targetFile !== filePath) {
        outgoing.get(filePath)?.add(targetFile);
        incoming.get(targetFile)?.add(filePath);
      }
    }
  }

  // Simple PageRank: count incoming references
  const scores = new Map<string, number>();
  for (const [filePath] of fileSymbols) {
    const inRefs = incoming.get(filePath)?.size || 0;
    scores.set(filePath, inRefs);
  }

  return scores;
}

// ── File collection ────────────────────────────────────────────────────

const MAX_FILE_SIZE = 100_000; // Skip files larger than 100KB
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target",
  "__pycache__", ".venv", "venv", "env", ".env",
  "vendor", "bower_components", "jspm_packages",
]);

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
 * Recursively collect source files for repo map.
 */
async function collectFiles(cwd: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      const fullPath = path.join(dir, name);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (!IGNORE_DIRS.has(name)) {
          await walk(fullPath);
        }
      } else if (stat.isFile()) {
        const ext = path.extname(name).slice(1).toLowerCase();
        const lang = EXT_TO_LANG[ext];
        if (lang && stat.size < MAX_FILE_SIZE) {
          files.push({ path: fullPath, lang });
        }
      }
    }
  }

  await walk(cwd);
  return files;
}

// ── Caching ────────────────────────────────────────────────────────────

const CACHE_TTL = 60_000; // 1 minute

let _cachedMap: string | null = null;
let _cachedCwd: string | null = null;
let _cachedAt = 0;

/**
 * Clear the cached repo map.
 */
export function clearRepoMapCache(): void {
  _cachedMap = null;
  _cachedCwd = null;
  _cachedAt = 0;
}

/**
 * Build a repo map showing key symbols across the codebase.
 *
 * @param cwd - Working directory
 * @param options
 * @param options.maxTokens - Approximate token budget for the map (default: 1500)
 * @returns Formatted repo map string, or null if no symbols found
 */
export async function buildRepoMap(cwd: string, { maxTokens = 1500 }: { maxTokens?: number } = {}): Promise<string | null> {
  // Check cache
  if (_cachedMap && _cachedCwd === cwd && (Date.now() - _cachedAt) < CACHE_TTL) {
    return _cachedMap;
  }

  const startTime = Date.now();
  const parser = getParser();
  if (!parser) return null; // tree-sitter not installed

  // Collect source files
  const files = await collectFiles(cwd);
  if (files.length === 0) return null;

  // Extract symbols and references from each file
  const fileSymbols = new Map<string, SymbolInfo[]>();
  const fileRefs = new Map<string, Set<string>>();
  let totalSymbols = 0;

  for (const file of files) {
    const relPath = path.relative(cwd, file.path);
    const grammar = loadGrammar(file.lang);
    if (!grammar) continue;

    try {
      const content = await fs.readFile(file.path, "utf-8");
      if (content.length > MAX_FILE_SIZE) continue;

      parser.setLanguage(grammar);
      const tree = parser.parse(content);
      const extractor = LANG_EXTRACTORS[file.lang];
      if (!extractor) continue;

      const symbols = extractor(tree.rootNode);
      if (symbols.length > 0) {
        fileSymbols.set(relPath, symbols);
        totalSymbols += symbols.length;
      }

      // Extract references for PageRank graph
      const refs = extractReferences(tree.rootNode);
      if (refs.size > 0) {
        fileRefs.set(relPath, refs);
      }
    } catch (err: unknown) {
      const error = err as Error;
      logger.debug(`repo-map: failed to parse ${relPath}: ${error.message}`);
    }
  }

  if (fileSymbols.size === 0) return null;

  // Compute PageRank scores for cross-file reference ranking
  let pageRankScores = new Map<string, number>();
  try {
    if (fileSymbols.size > 1 && fileRefs.size > 0) {
      pageRankScores = computePageRank(fileSymbols, fileRefs);
    }
  } catch (err: unknown) {
    const error = err as Error;
    logger.debug(`repo-map: PageRank computation failed, falling back to symbol count: ${error.message}`);
  }

  // Build the map, fitting within token budget
  // Approximate: 1 token ≈ 4 chars
  const charBudget = maxTokens * 4;
  const lines: string[] = [];
  let totalChars = 0;

  // Sort files by PageRank score (primary) with symbol count as tiebreaker
  const sortedFiles = [...fileSymbols.entries()]
    .sort((a, b) => {
      const scoreA = pageRankScores.get(a[0]) || 0;
      const scoreB = pageRankScores.get(b[0]) || 0;
      if (Math.abs(scoreA - scoreB) > 1e-9) return scoreB - scoreA;
      return b[1].length - a[1].length;
    });

  for (const [relPath, symbols] of sortedFiles) {
    // Limit to 8 symbols per file for compactness
    const limitedSymbols = symbols.slice(0, 8);
    const symbolParts = limitedSymbols.map(s => `${s.kind} ${s.name}:${s.line}`);
    const entry = `  ${relPath}: ${symbolParts.join(", ")}`;
    const entryChars = entry.length + 1;

    if (totalChars + entryChars > charBudget && lines.length > 0) {
      const remaining = sortedFiles.length - lines.length;
      if (remaining > 0) {
        lines.push(`  ... and ${remaining} more files`);
      }
      break;
    }

    lines.push(entry);
    totalChars += entryChars;
  }

  const elapsed = Date.now() - startTime;
  const hasPageRank = pageRankScores.size > 0;
  logger.info(`Repo map: ${fileSymbols.size} files, ${totalSymbols} symbols, PageRank=${hasPageRank} in ${elapsed}ms`);

  const result = `## Repository map\nKey symbols across ${fileSymbols.size} source files (use read_file to see details):\n${lines.join("\n")}`;

  // Cache
  _cachedMap = result;
  _cachedCwd = cwd;
  _cachedAt = Date.now();

  return result;
}