/**
 * Repository Map — inspired by Aider's tree-sitter repo map.
 *
 * Builds a compact "table of contents" for the codebase showing key symbols
 * (functions, classes, exports, types) with their file locations. This gives
 * the agent structural understanding without requiring multiple grep/read calls.
 *
 * Uses tree-sitter for accurate AST-based symbol extraction across languages:
 *   - JavaScript / JSX
 *   - TypeScript / TSX
 *   - Python
 *   - Go
 *   - Rust
 *   - Java
 *   - Ruby
 *
 * Design:
 *   - Scans source files in the project (respects ignore patterns)
 *   - Parses each file with the appropriate tree-sitter grammar
 *   - Extracts top-level symbols (functions, classes, types, exports)
 *   - Fits the map within a configurable token budget
 *   - Caches results for fast re-use within a session
 */

import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.js";

// tree-sitter is CJS — bridge to ESM (also used for graphology)
const require = createRequire(import.meta.url);

// ── Graphology for PageRank ──────────────────────────────────────────

let _Graph = null;
let _pagerank = null;

function getGraph() {
  if (!_Graph) {
    _Graph = require("graphology").Graph;
  }
  return _Graph;
}

function getPageRank() {
  if (!_pagerank) {
    _pagerank = require("graphology-metrics/centrality/pagerank");
  }
  return _pagerank;
}

// NOTE: require is defined above (shared by tree-sitter and graphology)

// ── Lazy-loaded grammars ──────────────────────────────────────────────

let _parser = null;
const _grammars = {};

function getParser() {
  if (!_parser) {
    const Parser = require("tree-sitter");
    _parser = new Parser();
  }
  return _parser;
}

/**
 * Load a tree-sitter grammar by language key.
 * Returns the grammar object or null if not available.
 */
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
  } catch (err) {
    logger.debug(`tree-sitter grammar not available for ${langKey}: ${err.message}`);
    _grammars[langKey] = null;
  }

  return _grammars[langKey];
}

// File extension → grammar key mapping
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

// Files/directories to always skip
const IGNORED_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".next", "dist", "build",
  "target", ".venv", "venv", "coverage", ".smol-agent", ".cache",
  "vendor", ".tox", "eggs", ".eggs", "bower_components",
]);

const IGNORED_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  ".DS_Store", "thumbs.db",
]);

// Safety limits
const MAX_FILES = 500;
const MAX_FILE_SIZE = 100_000; // 100KB — skip likely-generated files

// ── AST symbol extraction ─────────────────────────────────────────────

/**
 * Node type queries per language for top-level symbol extraction.
 *
 * Each entry maps AST node types to a function that extracts
 * { name, kind } from the node.
 */

function extractName(node, childType) {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;
  // Fallback: find first child of the expected type
  for (const child of node.children) {
    if (child.type === childType) return child.text;
  }
  return null;
}

/**
 * Extract symbols from a parsed tree for JavaScript/TypeScript.
 */
function extractJSTSSymbols(rootNode) {
  const symbols = [];

  for (const node of rootNode.children) {
    // Direct declarations at module level
    const sym = extractJSTSNode(node);
    if (sym) symbols.push(sym);

    // export_statement wraps declarations
    if (node.type === "export_statement") {
      const decl = node.childForFieldName("declaration");
      if (decl) {
        const sym2 = extractJSTSNode(decl);
        if (sym2) { sym2.exported = true; symbols.push(sym2); }
      }
      // export default function/class
      for (const child of node.children) {
        if (child.type !== "export" && child.type !== "default") {
          const sym3 = extractJSTSNode(child);
          if (sym3) { sym3.exported = true; symbols.push(sym3); }
        }
      }
    }
  }

  return dedup(symbols);
}

function extractJSTSNode(node) {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      return { name: extractName(node, "identifier"), kind: "fn", line: node.startPosition.row + 1 };

    case "class_declaration":
      return { name: extractName(node, "identifier"), kind: "class", line: node.startPosition.row + 1 };

    case "lexical_declaration":
    case "variable_declaration": {
      // const Foo = ... or const foo = () => ...
      for (const declarator of node.children) {
        if (declarator.type === "variable_declarator") {
          const nameNode = declarator.childForFieldName("name");
          if (!nameNode) continue;
          const name = nameNode.text;
          const value = declarator.childForFieldName("value");
          if (value) {
            if (value.type === "arrow_function" || value.type === "function_expression") {
              return { name, kind: "fn", line: node.startPosition.row + 1 };
            }
            if (value.type === "class" || value.type === "class_expression") {
              return { name, kind: "class", line: node.startPosition.row + 1 };
            }
          }
          // Capitalized constants are worth including
          if (name[0] === name[0].toUpperCase() && name.length > 1 && name !== name.toUpperCase()) {
            return { name, kind: "const", line: node.startPosition.row + 1 };
          }
        }
      }
      return null;
    }

    // TypeScript-specific
    case "interface_declaration":
      return { name: extractName(node, "type_identifier"), kind: "iface", line: node.startPosition.row + 1 };

    case "type_alias_declaration":
      return { name: extractName(node, "type_identifier"), kind: "type", line: node.startPosition.row + 1 };

    case "enum_declaration":
      return { name: extractName(node, "identifier"), kind: "enum", line: node.startPosition.row + 1 };

    default:
      return null;
  }
}

/**
 * Extract symbols from a parsed tree for Python.
 */
function extractPythonSymbols(rootNode) {
  const symbols = [];

  for (const node of rootNode.children) {
    switch (node.type) {
      case "function_definition": {
        const name = extractName(node, "identifier");
        if (name && !name.startsWith("_")) {
          symbols.push({ name, kind: "fn", line: node.startPosition.row + 1 });
        }
        break;
      }
      case "class_definition": {
        const name = extractName(node, "identifier");
        if (name) {
          symbols.push({ name, kind: "class", line: node.startPosition.row + 1 });
          // Also extract public methods
          const body = node.childForFieldName("body");
          if (body) {
            for (const member of body.children) {
              if (member.type === "function_definition") {
                const methodName = extractName(member, "identifier");
                if (methodName && !methodName.startsWith("_")) {
                  symbols.push({ name: `${name}.${methodName}`, kind: "method", line: member.startPosition.row + 1 });
                }
              }
            }
          }
        }
        break;
      }
      case "decorated_definition": {
        // @decorator def/class
        for (const child of node.children) {
          if (child.type === "function_definition") {
            const name = extractName(child, "identifier");
            if (name && !name.startsWith("_")) {
              symbols.push({ name, kind: "fn", line: child.startPosition.row + 1 });
            }
          } else if (child.type === "class_definition") {
            const name = extractName(child, "identifier");
            if (name) {
              symbols.push({ name, kind: "class", line: child.startPosition.row + 1 });
            }
          }
        }
        break;
      }
    }
  }

  return symbols;
}

/**
 * Extract symbols from a parsed tree for Go.
 */
function extractGoSymbols(rootNode) {
  const symbols = [];

  for (const node of rootNode.children) {
    switch (node.type) {
      case "function_declaration": {
        const name = extractName(node, "identifier");
        if (name && name[0] === name[0].toUpperCase()) {
          symbols.push({ name, kind: "fn", line: node.startPosition.row + 1 });
        }
        break;
      }
      case "method_declaration": {
        const name = extractName(node, "field_identifier");
        if (name && name[0] === name[0].toUpperCase()) {
          symbols.push({ name, kind: "method", line: node.startPosition.row + 1 });
        }
        break;
      }
      case "type_declaration": {
        for (const spec of node.children) {
          if (spec.type === "type_spec") {
            const name = extractName(spec, "type_identifier");
            if (name) {
              const typeNode = spec.childForFieldName("type");
              const kindStr = typeNode?.type === "interface_type" ? "iface" : "type";
              symbols.push({ name, kind: kindStr, line: spec.startPosition.row + 1 });
            }
          }
        }
        break;
      }
    }
  }

  return symbols;
}

/**
 * Extract symbols from a parsed tree for Rust.
 */
function extractRustSymbols(rootNode) {
  const symbols = [];

  for (const node of rootNode.children) {
    switch (node.type) {
      case "function_item": {
        const name = extractName(node, "identifier");
        if (name) {
          const isPub = node.children.some(c => c.type === "visibility_modifier");
          symbols.push({ name, kind: "fn", line: node.startPosition.row + 1, exported: isPub });
        }
        break;
      }
      case "struct_item": {
        const name = extractName(node, "type_identifier");
        if (name) symbols.push({ name, kind: "struct", line: node.startPosition.row + 1 });
        break;
      }
      case "enum_item": {
        const name = extractName(node, "type_identifier");
        if (name) symbols.push({ name, kind: "enum", line: node.startPosition.row + 1 });
        break;
      }
      case "trait_item": {
        const name = extractName(node, "type_identifier");
        if (name) symbols.push({ name, kind: "trait", line: node.startPosition.row + 1 });
        break;
      }
      case "impl_item": {
        // Extract the type being implemented
        const typeNode = node.childForFieldName("type");
        if (typeNode) {
          const typeName = typeNode.text;
          const body = node.childForFieldName("body");
          if (body) {
            for (const member of body.children) {
              if (member.type === "function_item") {
                const methodName = extractName(member, "identifier");
                const isPub = member.children.some(c => c.type === "visibility_modifier");
                if (methodName && isPub) {
                  symbols.push({ name: `${typeName}::${methodName}`, kind: "method", line: member.startPosition.row + 1 });
                }
              }
            }
          }
        }
        break;
      }
    }
  }

  return symbols;
}

/**
 * Extract symbols from a parsed tree for Java.
 */
function extractJavaSymbols(rootNode) {
  const symbols = [];

  function walk(node) {
    switch (node.type) {
      case "class_declaration":
      case "interface_declaration":
      case "enum_declaration": {
        const name = extractName(node, "identifier");
        const kind = node.type === "interface_declaration" ? "iface"
          : node.type === "enum_declaration" ? "enum" : "class";
        if (name) symbols.push({ name, kind, line: node.startPosition.row + 1 });
        // Walk body for methods
        const body = node.childForFieldName("body");
        if (body) {
          for (const member of body.children) {
            if (member.type === "method_declaration") {
              const methodName = extractName(member, "identifier");
              if (methodName) {
                symbols.push({ name: `${name}.${methodName}`, kind: "method", line: member.startPosition.row + 1 });
              }
            }
          }
        }
        break;
      }
    }
  }

  // Java has program -> (class_declaration | ...)
  for (const child of rootNode.children) {
    walk(child);
  }

  return symbols;
}

/**
 * Extract symbols from a parsed tree for Ruby.
 */
function extractRubySymbols(rootNode) {
  const symbols = [];

  function walk(node, prefix = "") {
    switch (node.type) {
      case "class":
      case "module": {
        const nameNode = node.childForFieldName("name");
        const name = nameNode ? nameNode.text : null;
        if (name) {
          const fullName = prefix ? `${prefix}::${name}` : name;
          symbols.push({ name: fullName, kind: node.type === "module" ? "module" : "class", line: node.startPosition.row + 1 });
          // Walk body
          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.children) {
              walk(child, fullName);
            }
          }
        }
        break;
      }
      case "method": {
        const nameNode = node.childForFieldName("name");
        const name = nameNode ? nameNode.text : null;
        if (name && !name.startsWith("_")) {
          const fullName = prefix ? `${prefix}#${name}` : name;
          symbols.push({ name: fullName, kind: "method", line: node.startPosition.row + 1 });
        }
        break;
      }
      case "singleton_method": {
        const nameNode = node.childForFieldName("name");
        const name = nameNode ? nameNode.text : null;
        if (name) {
          const fullName = prefix ? `${prefix}.${name}` : name;
          symbols.push({ name: fullName, kind: "method", line: node.startPosition.row + 1 });
        }
        break;
      }
    }
  }

  for (const child of rootNode.children) {
    walk(child);
  }

  return symbols;
}

// Dispatcher
const LANG_EXTRACTORS = {
  javascript: extractJSTSSymbols,
  typescript: extractJSTSSymbols,
  tsx: extractJSTSSymbols,
  python: extractPythonSymbols,
  go: extractGoSymbols,
  rust: extractRustSymbols,
  java: extractJavaSymbols,
  ruby: extractRubySymbols,
};

// ── Reference (identifier) extraction for PageRank ───────────────────

/**
 * Collect all identifier references from an AST.
 * Returns a Set of identifier names used in the file (for cross-file matching).
 */
function extractReferences(rootNode) {
  const refs = new Set();
  const stack = [rootNode];

  while (stack.length > 0) {
    const node = stack.pop();
    // Collect identifiers that look like references to definitions
    if (
      node.type === "identifier" ||
      node.type === "type_identifier" ||
      node.type === "property_identifier" ||
      node.type === "field_identifier"
    ) {
      const text = node.text;
      // Skip very short names (a, b, i, j) and all-caps constants
      if (text.length > 2 && text !== text.toUpperCase()) {
        refs.add(text);
      }
    }
    // Walk children
    for (let i = 0; i < node.childCount; i++) {
      stack.push(node.child(i));
    }
  }

  return refs;
}

/**
 * Build a cross-file reference graph and compute PageRank scores.
 *
 * Algorithm (inspired by Aider):
 *   1. For each file, collect defined symbol names and referenced identifiers
 *   2. Build a directed graph: edge from file A → file B when A references
 *      a symbol defined in B (weighted by name length — longer = more specific)
 *   3. Run PageRank to determine file importance
 *
 * @param {Map<string, object[]>} fileSymbols - Map of relPath → symbol[]
 * @param {Map<string, Set<string>>} fileRefs - Map of relPath → Set of identifier references
 * @returns {Map<string, number>} Map of relPath → PageRank score
 */
function computePageRank(fileSymbols, fileRefs) {
  const Graph = getGraph();
  const pagerank = getPageRank();

  const graph = new Graph({ type: "directed", allowSelfLoops: false });

  // Add all files as nodes
  for (const relPath of fileSymbols.keys()) {
    graph.addNode(relPath);
  }

  // Build definition index: symbolName → [files that define it]
  const defIndex = new Map();
  for (const [relPath, symbols] of fileSymbols) {
    for (const sym of symbols) {
      // Use base name (strip Class. or Class:: prefixes)
      const baseName = sym.name.includes(".")
        ? sym.name.split(".").pop()
        : sym.name.includes("::")
          ? sym.name.split("::").pop()
          : sym.name.includes("#")
            ? sym.name.split("#").pop()
            : sym.name;

      if (!defIndex.has(baseName)) {
        defIndex.set(baseName, []);
      }
      defIndex.get(baseName).push(relPath);
    }
  }

  // Add edges: referencer → definer
  for (const [refFile, refs] of fileRefs) {
    if (!graph.hasNode(refFile)) continue;

    for (const refName of refs) {
      const definers = defIndex.get(refName);
      if (!definers) continue;

      for (const defFile of definers) {
        if (defFile === refFile) continue; // skip self-refs
        if (!graph.hasNode(defFile)) continue;

        // Weight by name length (longer names = more specific references)
        const weight = Math.min(refName.length / 5, 3);

        if (graph.hasEdge(refFile, defFile)) {
          const existing = graph.getEdgeAttribute(refFile, defFile, "weight");
          graph.setEdgeAttribute(refFile, defFile, "weight", existing + weight);
        } else {
          graph.addEdge(refFile, defFile, { weight });
        }
      }
    }
  }

  // Run PageRank
  const scores = pagerank(graph, {
    alpha: 0.85,
    maxIterations: 100,
    tolerance: 1e-6,
    weighted: true,
  });

  return new Map(Object.entries(scores));
}

// ── Utility ───────────────────────────────────────────────────────────

function dedup(symbols) {
  const seen = new Set();
  return symbols.filter(s => {
    if (!s.name) return false;
    const key = `${s.name}:${s.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── File scanning ─────────────────────────────────────────────────────

async function collectFiles(dir, files = [], depth = 0) {
  if (depth > 6 || files.length >= MAX_FILES) return files;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (files.length >= MAX_FILES) break;

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await collectFiles(path.join(dir, entry.name), files, depth + 1);
    } else {
      if (IGNORED_FILES.has(entry.name)) continue;
      const ext = entry.name.split(".").pop()?.toLowerCase();
      if (ext && EXT_TO_LANG[ext]) {
        files.push({ path: path.join(dir, entry.name), ext, lang: EXT_TO_LANG[ext] });
      }
    }
  }

  return files;
}

// ── Cache ─────────────────────────────────────────────────────────────

let _cachedMap = null;
let _cachedCwd = null;
let _cachedAt = 0;
const CACHE_TTL = 60_000; // 1 minute

/**
 * Clear the repo map cache. Call when files are known to have changed.
 */
export function clearRepoMapCache() {
  _cachedMap = null;
  _cachedCwd = null;
  _cachedAt = 0;
  // Reset parser and grammars to avoid stale native module state (important for test isolation)
  _parser = null;
  for (const key of Object.keys(_grammars)) {
    delete _grammars[key];
  }
}

// ── Main entry point ──────────────────────────────────────────────────

/**
 * Build a repository map for the given project directory.
 *
 * @param {string} cwd - Project root directory
 * @param {object} [options]
 * @param {number} [options.maxTokens=1500] - Approximate token budget for the map
 * @returns {Promise<string|null>} Formatted repo map string, or null if no symbols found
 */
export async function buildRepoMap(cwd, { maxTokens = 1500 } = {}) {
  // Check cache
  if (_cachedMap && _cachedCwd === cwd && (Date.now() - _cachedAt) < CACHE_TTL) {
    return _cachedMap;
  }

  const startTime = Date.now();
  const parser = getParser();

  // Collect source files
  const files = await collectFiles(cwd);
  if (files.length === 0) return null;

  // Extract symbols and references from each file
  const fileSymbols = new Map(); // relativePath -> symbol[]
  const fileRefs = new Map();    // relativePath -> Set<string> (identifier references)
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
    } catch (err) {
      logger.debug(`repo-map: failed to parse ${relPath}: ${err.message}`);
    }
  }

  if (fileSymbols.size === 0) return null;

  // Compute PageRank scores for cross-file reference ranking
  let pageRankScores = new Map();
  try {
    if (fileSymbols.size > 1 && fileRefs.size > 0) {
      pageRankScores = computePageRank(fileSymbols, fileRefs);
    }
  } catch (err) {
    logger.debug(`repo-map: PageRank computation failed, falling back to symbol count: ${err.message}`);
  }

  // Build the map, fitting within token budget
  // Approximate: 1 token ≈ 4 chars
  const charBudget = maxTokens * 4;
  const lines = [];
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
    const symbolParts = symbols.map(s => `${s.kind} ${s.name}:${s.line}`);
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
